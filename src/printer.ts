import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { config } from './config.js';
import { log } from './logger.js';

const run = promisify(execFile);
const isWindows = platform() === 'win32';

export interface SendResult {
  /** false only means PRINTER_NAME is unset — the PDF was left for a human. */
  sent: boolean;
  /**
   * Set when `sent` is true but the handoff couldn't be confirmed — the job
   * was never actually observed reaching the printer's queue with a
   * `DocumentName` tying it to this PDF. Undefined on a confirmed send:
   * always on CUPS, and on Windows only when a job was seen *and matched*
   * (not merely "a job was seen" — a foreign job on a shared printer can
   * satisfy the former without the latter). Callers should treat this as
   * "printed, but verify" rather than a plain success.
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
// There's no Windows equivalent of `lp -d <printer>`. An earlier version of
// this used the registered PDF handler's "Print" shell verb
// (`Start-Process -Verb Print`), which on every Windows box resolves to
// Edge — and Edge's Print verb opens Edge and shows its own print dialog
// rather than printing silently, so every run needed a human to click
// "Print" in that popup. That defeats the point of automating this at all,
// so this now shells out to SumatraPDF instead: a free, portable PDF viewer
// (no install/admin rights needed) whose `-print-to <printer> -silent`
// flags print with no UI at all, and whose process only exits once the job
// has actually been submitted — so a clean exit *is* the confirmation,
// unlike the old approach, which had to poll the print queue afterward to
// guess whether Edge had actually submitted the job yet.
//
// Everything here is deliberately loud on failure. The CUPS path gets that
// for free (`lp` exits non-zero on a bad `-d`); `resolvePrinterWindows`
// below gives Windows the same property by validating PRINTER_NAME against
// the installed printers before ever invoking SumatraPDF.

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

/**
 * Print one copy via SumatraPDF's silent CLI. `-print-to` targets a named
 * printer directly (no default-printer juggling needed, unlike the old
 * Edge-verb approach); `-silent` suppresses all UI; `-exit-when-done` makes
 * the process wait until the job is actually handed to the spooler before
 * exiting, so a clean (zero) exit code *is* the print confirmation — no
 * queue-polling required to find out whether it worked.
 */
async function printOneCopyWindows(pdfPath: string, printerName: string): Promise<void> {
  try {
    await run(config.sumatraPath, ['-print-to', printerName, '-silent', '-exit-when-done', pdfPath]);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `Can't find SumatraPDF at "${config.sumatraPath}". Silent Windows printing needs the portable ` +
          `SumatraPDF.exe (free, no install/admin rights required) — download it from ` +
          `https://www.sumatrapdfreader.org/download-free-pdf-viewer, then either put it on PATH or set ` +
          `SUMATRA_PATH in .env to its full path.`,
      );
    }
    throw new Error(`SumatraPDF failed to print "${pdfPath}" to "${printerName}": ${errText(err)}`);
  }
}

async function sendToPrinterWindows(pdfPath: string, copies: number): Promise<SendResult> {
  const target = await resolvePrinterWindows(config.printerName);

  for (let i = 0; i < copies; i++) {
    log.step(`Printing copy ${i + 1}/${copies} of ${pdfPath} to "${target}" via SumatraPDF`);
    await printOneCopyWindows(pdfPath, target);
  }

  log.done(`Sent ${copies} job(s) to ${target}.`);
  return { sent: true };
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
