import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { config } from './config.js';
import { log } from './logger.js';

const run = promisify(execFile);
const isWindows = platform() === 'win32';

/**
 * Send a PDF to a printer. No-op when PRINTER_NAME is unset, which is the
 * safe default: the PDF is still on disk for a human to review.
 */
export async function sendToPrinter(pdfPath: string, copies = 1): Promise<boolean> {
  if (!config.printerName) {
    log.info(`PRINTER_NAME not set — leaving PDF at ${pdfPath}`);
    return false;
  }

  return isWindows ? sendToPrinterWindows(pdfPath, copies) : sendToPrinterCups(pdfPath, copies);
}

/** Convenience for `npm run print -- --printers`: list known printers. */
export async function listPrinters(): Promise<string[]> {
  return isWindows ? listPrintersWindows() : listPrintersCups();
}

// --- macOS / Linux: CUPS -----------------------------------------------

async function sendToPrinterCups(pdfPath: string, copies: number): Promise<boolean> {
  const args = ['-d', config.printerName, '-n', String(copies), pdfPath];
  log.step(`lp ${args.join(' ')}`);
  const { stdout } = await run('lp', args);
  log.done(`Queued: ${stdout.trim()}`);
  return true;
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
 * and splicing them produced silently-wrong WQL filters.
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
 * Set the machine's default printer, then read it back to confirm. The
 * read-back is the point: `Invoke-CimMethod` on a null input doesn't
 * reliably surface as a non-zero exit code, so without it a typo'd
 * PRINTER_NAME silently leaves the previous default in place.
 */
async function setDefaultPrinterWindows(name: string): Promise<void> {
  await runPowerShell(
    'Invoke-CimMethod -InputObject (Get-CimInstance -ClassName Win32_Printer -Filter "Name=`"$($env:SC_PRINTER)`"") -MethodName SetDefaultPrinter | Out-Null',
    { SC_PRINTER: name },
  ).catch((err: unknown) => {
    throw new Error(`Could not set "${name}" as the Windows default printer: ${errText(err)}`);
  });

  const actual = await getDefaultPrinterWindows();
  if (actual !== name) {
    throw new Error(
      `Tried to set the Windows default printer to "${name}" but it is "${actual || '(none)'}". ` +
        `Check PRINTER_NAME in .env matches a name from \`npm run print -- --printers\` exactly.`,
    );
  }
}

/**
 * Count jobs currently queued on a printer, or null if the queue can't be
 * read at all (`Get-PrintJob` lives in the PrintManagement module and isn't
 * guaranteed present). null means "unknown", which callers treat very
 * differently from a genuine zero.
 */
async function printJobCount(printerName: string): Promise<number | null> {
  const out = await runPowerShell('@(Get-PrintJob -PrinterName $env:SC_PRINTER).Count', {
    SC_PRINTER: printerName,
  }).catch(() => null);
  if (out === null) return null;
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Wait for the PDF handler to actually submit the job. `Start-Process -Verb
 * Print` returns as soon as the viewer *launches* — the viewer reads the
 * default printer when it submits, which can be many seconds later on an
 * Edge cold start. Restoring the default before then would send the labels
 * to the wrong printer while still reporting success, so hold the default
 * until the job shows up in the target printer's queue.
 *
 * Returns false only when the queue was readable and nothing ever appeared.
 * A short label job can spool and clear between polls, so a miss is treated
 * as inconclusive by the caller, not as proof of failure.
 */
async function waitForPrintJob(printerName: string, baseline: number): Promise<boolean> {
  const deadline = Date.now() + JOB_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const count = await printJobCount(printerName);
    if (count !== null && count > baseline) return true;
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
  }
  return false;
}

async function sendToPrinterWindows(pdfPath: string, copies: number): Promise<boolean> {
  const target = config.printerName;
  const previousDefault = await getDefaultPrinterWindows();

  log.step(`Setting Windows default printer to ${target}`);
  await setDefaultPrinterWindows(target);

  try {
    for (let i = 0; i < copies; i++) {
      log.step(`Sending print job ${i + 1}/${copies} for ${pdfPath}`);
      const baseline = await printJobCount(target);
      await runPowerShell('Start-Process -FilePath $env:SC_PDF_PATH -Verb Print', { SC_PDF_PATH: pdfPath });

      if (baseline === null) {
        // Can't read the queue, so there's nothing to poll. Hold the default
        // printer for a fixed interval instead — still the whole point, since
        // restoring it early is what sends labels to the wrong printer.
        log.warn(
          `Can't read "${target}"'s print queue (Get-PrintJob unavailable), so the job can't be ` +
            `confirmed — waiting ${HANDOFF_FALLBACK_MS / 1000}s for the PDF viewer to submit it.`,
        );
        await new Promise((resolve) => setTimeout(resolve, HANDOFF_FALLBACK_MS));
      } else if (!(await waitForPrintJob(target, baseline))) {
        // Inconclusive, not proof of failure: a one-page label can spool and
        // clear the queue between polls. Warn rather than fail the SKU, since
        // a false failure invites a duplicate reprint of the whole batch.
        log.warn(
          `Never saw the job appear in "${target}"'s queue within ${JOB_POLL_TIMEOUT_MS / 1000}s. ` +
            `It may have printed and cleared too quickly to observe. If nothing came out, the PDF is ` +
            `still at ${pdfPath} — check that a PDF viewer with a Print action is installed (Edge or Acrobat).`,
        );
      }
    }
    log.done(`Sent ${copies} job(s) to ${target}`);
    return true;
  } finally {
    await restoreDefaultPrinterWindows(previousDefault, target);
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
