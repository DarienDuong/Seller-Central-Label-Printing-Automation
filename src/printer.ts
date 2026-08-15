import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { basename } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const run = promisify(execFile);
const isWindows = platform() === 'win32';

export interface SendResult {
  /** false only means PRINTER_NAME is unset — the PDF was left for a human. */
  sent: boolean;
  /**
   * Set when `sent` is true but the handoff couldn't be confirmed — the job
   * was never actually observed reaching the printer's queue. Undefined on
   * a confirmed send (always on CUPS; on Windows, whenever the job was
   * seen). Callers should treat this as "printed, but verify" rather than
   * a plain success.
   */
  unconfirmed?: string;
}

/**
 * Send a PDF to a printer. No-op when PRINTER_NAME is unset, which is the
 * safe default: the PDF is still on disk for a human to review.
 */
export async function sendToPrinter(pdfPath: string, copies = 1): Promise<SendResult> {
  if (!config.printerName) {
    log.info(`PRINTER_NAME not set — leaving PDF at ${pdfPath}`);
    return { sent: false };
  }

  return isWindows ? sendToPrinterWindows(pdfPath, copies) : sendToPrinterCups(pdfPath, copies);
}

/** Convenience for `npm run print -- --printers`: list known printers. */
export async function listPrinters(): Promise<string[]> {
  return isWindows ? listPrintersWindows() : listPrintersCups();
}

// --- macOS / Linux: CUPS -----------------------------------------------

async function sendToPrinterCups(pdfPath: string, copies: number): Promise<SendResult> {
  const args = ['-d', config.printerName, '-n', String(copies), pdfPath];
  log.step(`lp ${args.join(' ')}`);
  const { stdout } = await run('lp', args);
  log.done(`Queued: ${stdout.trim()}`);
  return { sent: true };
}

async function listPrintersCups(): Promise<string[]> {
  const { stdout } = await run('lpstat', ['-p']).catch((err: unknown) => {
    log.warn(`lpstat failed — printer list may be incomplete: ${errText(err)}`);
    return { stdout: '' };
  });
  return stdout
    .split('\n')
    .map((line) => line.match(/^printer (\S+)/)?.[1])
    .filter((n): n is string => Boolean(n));
}

// --- Windows: no CUPS, no CLI print-to-named-printer for PDFs -----------
//
// There's no Windows equivalent of `lp -d <printer>`. The only
// printer-agnostic route is the registered PDF handler's "Print" shell verb
// (`Start-Process -Verb Print`), and that verb always targets the current
// *default* printer — it doesn't take a printer name. So this flips the
// Windows default printer to PRINTER_NAME, fires the print verb once per
// copy, waits for the job to actually reach that printer's queue, then
// restores whatever the default printer was before. Requires a PDF viewer
// with a registered Print verb (Edge and Acrobat both ship one, and Edge is
// on every Windows box).
//
// Everything here is deliberately loud on failure. The CUPS path gets that
// for free (`lp` exits non-zero on a bad `-d`), but the Windows path's
// natural failure mode is silent: a printer name that matches nothing just
// leaves the old default in place and prints the labels to the wrong device.

const JOB_POLL_TIMEOUT_MS = 60_000;
const JOB_POLL_INTERVAL_MS = 500;
/** Used only when the print queue can't be read and there's nothing to poll. */
const HANDOFF_FALLBACK_MS = 15_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a PowerShell script. Values are passed as *environment variables*
 * (read inside the script as `$env:NAME`), never spliced into the script
 * text — printer names and paths routinely contain quotes, `$`, and spaces,
 * and splicing them produced silently-wrong filters.
 */
async function runPowerShell(script: string, vars: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${script}`],
    { env: { ...process.env, ...vars } },
  );
  return stdout.trim();
}

async function getDefaultPrinterWindows(): Promise<string> {
  return runPowerShell('(Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Default }).Name');
}

/**
 * Resolve PRINTER_NAME to the exact string Windows uses for it. Matching via
 * `Where-Object -eq` (case-insensitive, same as Windows itself) instead of a
 * WQL `-Filter` string sidesteps WQL's own quoting rules entirely — WQL
 * treats `\` as an escape character inside a string literal, so a network
 * printer name like `\\PRINTSERVER\Zebra ZD420` silently matched nothing
 * under a filter-string approach. Every later step uses this resolved name,
 * so a case difference between `.env` and Windows can't cause a false
 * "did the set actually take?" mismatch downstream.
 */
async function resolvePrinterWindows(name: string): Promise<string> {
  const actual = await runPowerShell(
    '(Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Name -eq $env:SC_PRINTER } | Select-Object -First 1).Name',
    { SC_PRINTER: name },
  );
  if (!actual) {
    throw new Error(
      `No Windows printer matches PRINTER_NAME "${name}". Run \`npm run print -- --printers\` and copy the name exactly.`,
    );
  }
  return actual;
}

async function applyDefaultPrinterWindows(name: string): Promise<void> {
  await runPowerShell(
    'Invoke-CimMethod -InputObject (Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Name -eq $env:SC_PRINTER } | Select-Object -First 1) -MethodName SetDefaultPrinter | Out-Null',
    { SC_PRINTER: name },
  );
}

async function confirmDefaultPrinterWindows(expected: string): Promise<void> {
  const actual = await getDefaultPrinterWindows();
  if (actual !== expected) {
    throw new Error(
      `Set the Windows default printer but it now reads back as "${actual || '(none)'}", not "${expected}" — ` +
        `it may have changed again between the set and the check. Try the run again.`,
    );
  }
}

/** Set the machine's default printer, then read it back to confirm the set actually took. */
async function setDefaultPrinterWindows(name: string): Promise<void> {
  await applyDefaultPrinterWindows(name);
  await confirmDefaultPrinterWindows(name);
}

/** Ids of jobs currently queued on a printer. Throws (with the real cause) if the queue can't be read. */
async function queryPrintJobIds(printerName: string): Promise<Set<string>> {
  const out = await runPowerShell(
    '(Get-PrintJob -PrinterName $env:SC_PRINTER | Select-Object -ExpandProperty Id) -join ","',
    { SC_PRINTER: printerName },
  );
  return new Set(
    out
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Wait for *our* job to appear in the target printer's queue. The whole wait
 * loop runs as a *single* PowerShell process (`Start-Sleep` inside the
 * script) rather than one process per poll tick — spawning `powershell.exe`
 * per tick made the real poll period several times `JOB_POLL_INTERVAL_MS`
 * once PowerShell startup and the PrintManagement module's autoload are
 * counted on every spawn, which widens exactly the blind window this
 * function exists to shrink: a one-page label job can spool and clear the
 * queue between ticks.
 *
 * "Ours" is checked by `DocumentName` matching the PDF's file name, not just
 * "any id outside the baseline" — on a shared printer, a concurrent job from
 * another machine can land in the queue during the same window (Edge is
 * still cold-starting, a coworker's job arrives first), satisfy an
 * any-new-id test, and release the default printer before our job actually
 * submits. If no name match ever appears before the deadline but *some* new
 * job did, that's reported as a fallback match — `DocumentName` isn't
 * guaranteed to equal the file name for every PDF handler, so treating an
 * unmatched name as outright failure would trade one false negative for
 * another.
 *
 * Returns false only when nothing new appeared at all. A transient failure
 * to read the queue mid-poll is swallowed inside the script and treated as
 * an inconclusive tick, not a hard stop — `queryPrintJobIds` already proved
 * the queue was readable before this function was called.
 */
async function waitForPrintJob(printerName: string, baselineIds: Set<string>, pdfPath: string): Promise<boolean> {
  const script = `
    $deadline = (Get-Date).AddMilliseconds([double]$env:SC_TIMEOUT_MS)
    $baseline = @($env:SC_BASELINE -split ',' | Where-Object { $_ -ne '' })
    $docName = $env:SC_DOC_NAME
    $sawForeignOnly = $false
    while ((Get-Date) -lt $deadline) {
      try {
        $newJobs = @(Get-PrintJob -PrinterName $env:SC_PRINTER -ErrorAction Stop | Where-Object { $baseline -notcontains $_.Id })
        if (@($newJobs | Where-Object { $_.DocumentName -eq $docName }).Count -gt 0) { Write-Output 'FOUND'; exit 0 }
        if ($newJobs.Count -gt 0) { $sawForeignOnly = $true }
      } catch {}
      Start-Sleep -Milliseconds ([int]$env:SC_INTERVAL_MS)
    }
    if ($sawForeignOnly) { Write-Output 'FOUND_UNMATCHED_NAME' } else { Write-Output 'TIMEOUT' }
  `;
  const result = await runPowerShell(script, {
    SC_PRINTER: printerName,
    SC_TIMEOUT_MS: String(JOB_POLL_TIMEOUT_MS),
    SC_INTERVAL_MS: String(JOB_POLL_INTERVAL_MS),
    SC_BASELINE: [...baselineIds].join(','),
    SC_DOC_NAME: basename(pdfPath),
  });
  return result === 'FOUND' || result === 'FOUND_UNMATCHED_NAME';
}

async function sendToPrinterWindows(pdfPath: string, copies: number): Promise<SendResult> {
  const target = await resolvePrinterWindows(config.printerName);
  const previousDefault = await getDefaultPrinterWindows();
  let changedDefault = false;
  // Reasons the handoff couldn't be confirmed for one or more copies. Kept
  // separate from a throw: an unconfirmed handoff is not proof of failure
  // (see waitForPrintJob's doc comment), so it's surfaced to the caller as
  // data on a successful return rather than raised as an error.
  const unconfirmedReasons: string[] = [];

  try {
    log.step(`Setting Windows default printer to ${target}`);
    await applyDefaultPrinterWindows(target);
    // Track that the mutation ran (not just that it was confirmed) so a
    // failure in confirmDefaultPrinterWindows below still triggers a
    // restore attempt in the finally block, instead of leaving the machine
    // flipped with nothing to undo it.
    changedDefault = true;
    await confirmDefaultPrinterWindows(target);

    for (let i = 0; i < copies; i++) {
      log.step(`Sending print job ${i + 1}/${copies} for ${pdfPath}`);

      // Job identity, not a raw count: with copies > 1, a same-size baseline
      // count can't tell copy 2's job apart from copy 1's, which may have
      // already spooled and cleared the queue by the time copy 2 is checked.
      let baselineIds: Set<string> | null = null;
      try {
        baselineIds = await queryPrintJobIds(target);
      } catch (err) {
        const reason =
          `Can't read "${target}"'s print queue (${errText(err)}), so the job can't be confirmed — ` +
          `waited ${HANDOFF_FALLBACK_MS / 1000}s for the PDF viewer to submit it instead of polling.`;
        log.warn(reason);
        unconfirmedReasons.push(reason);
      }

      await runPowerShell('Start-Process -FilePath $env:SC_PDF_PATH -Verb Print', { SC_PDF_PATH: pdfPath });

      if (baselineIds === null) {
        // Can't read the queue, so there's nothing to poll. Hold the default
        // printer for a fixed interval instead — still the whole point, since
        // restoring it early is what sends labels to the wrong printer.
        await new Promise((resolve) => setTimeout(resolve, HANDOFF_FALLBACK_MS));
      } else if (!(await waitForPrintJob(target, baselineIds, pdfPath))) {
        // Inconclusive, not proof of failure: a one-page label can spool and
        // clear the queue before the next poll. Warn rather than fail the
        // SKU — a false failure invites a duplicate reprint of the batch.
        const reason =
          `Never saw a new job appear in "${target}"'s queue within ${JOB_POLL_TIMEOUT_MS / 1000}s — ` +
          `the handoff was not confirmed. It may have printed and cleared too quickly to observe; if ` +
          `nothing came out, the PDF is still at ${pdfPath} — check that a PDF viewer with a Print ` +
          `action is installed (Edge or Acrobat).`;
        log.warn(reason);
        unconfirmedReasons.push(reason);
      }
    }
    log.done(`Sent ${copies} job(s) to ${target}`);
    return unconfirmedReasons.length > 0
      ? { sent: true, unconfirmed: unconfirmedReasons.join(' ') }
      : { sent: true };
  } finally {
    if (changedDefault) await restoreDefaultPrinterWindows(previousDefault, target);
  }
}

/**
 * Put the machine's default printer back. Never throws — this runs in a
 * `finally`, and masking the original print error with a restore error
 * would be worse than warning about it.
 */
async function restoreDefaultPrinterWindows(previousDefault: string, target: string): Promise<void> {
  if (previousDefault === target) return;

  // A box with no default printer at all (freshly imaged / kiosk-style
  // warehouse PCs) reports an empty name. There's no "unset the default"
  // API, so the honest move is to say the setting was changed rather than
  // silently leave PRINTER_NAME as a new machine-wide default.
  if (!previousDefault) {
    log.warn(
      `This machine had no default printer before this run, so "${target}" has been left as the ` +
        `Windows default. Change it in Settings → Bluetooth & devices → Printers & scanners if that's not wanted.`,
    );
    return;
  }

  log.step(`Restoring Windows default printer to ${previousDefault}`);
  await setDefaultPrinterWindows(previousDefault).catch((err: unknown) => {
    log.warn(
      `Could not restore the Windows default printer to "${previousDefault}" — it may still be ` +
        `set to "${target}": ${errText(err)}`,
    );
  });
}

async function listPrintersWindows(): Promise<string[]> {
  const stdout = await runPowerShell('(Get-CimInstance -ClassName Win32_Printer).Name').catch((err: unknown) => {
    log.warn(`Could not query Windows printers — list may be incomplete: ${errText(err)}`);
    return '';
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
