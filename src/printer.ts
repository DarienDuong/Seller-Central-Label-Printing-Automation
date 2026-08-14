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
  const { stdout } = await run('lpstat', ['-p']).catch(() => ({ stdout: '' }));
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
// copy, gives the handler time to spool, then restores whatever the default
// printer was before. Requires a PDF viewer with a registered Print verb
// (Edge and Acrobat both ship one, and Edge is on every Windows box).

async function runPowerShell(script: string): Promise<string> {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return stdout.trim();
}

function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

async function setDefaultPrinterWindows(name: string): Promise<void> {
  await runPowerShell(
    `Invoke-CimMethod -InputObject (Get-CimInstance -ClassName Win32_Printer -Filter "Name='${psQuote(name)}'") -MethodName SetDefaultPrinter | Out-Null`,
  );
}

async function sendToPrinterWindows(pdfPath: string, copies: number): Promise<boolean> {
  const previousDefault = await runPowerShell(
    '(Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Default }).Name',
  );

  log.step(`Setting Windows default printer to ${config.printerName}`);
  await setDefaultPrinterWindows(config.printerName);

  try {
    for (let i = 0; i < copies; i++) {
      log.step(`Sending print job ${i + 1}/${copies} for ${pdfPath}`);
      await runPowerShell(`Start-Process -FilePath '${psQuote(pdfPath)}' -Verb Print`);
      // The Print verb hands off to the registered PDF handler asynchronously
      // (it opens a viewer process and returns immediately) — give it a beat
      // to spool before firing the next copy or restoring the default printer.
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    log.done(`Sent ${copies} job(s) to ${config.printerName}`);
    return true;
  } finally {
    if (previousDefault && previousDefault !== config.printerName) {
      log.step(`Restoring Windows default printer to ${previousDefault}`);
      await setDefaultPrinterWindows(previousDefault);
    }
  }
}

async function listPrintersWindows(): Promise<string[]> {
  const stdout = await runPowerShell('(Get-CimInstance -ClassName Win32_Printer).Name').catch(() => '');
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
