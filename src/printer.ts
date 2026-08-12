import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './logger.js';

const run = promisify(execFile);

/**
 * Send a PDF to a CUPS printer (macOS/Linux). No-op when PRINTER_NAME is unset,
 * which is the safe default: the PDF is still on disk for a human to review.
 */
export async function sendToPrinter(pdfPath: string, copies = 1): Promise<boolean> {
  if (!config.printerName) {
    log.info(`PRINTER_NAME not set — leaving PDF at ${pdfPath}`);
    return false;
  }

  const args = ['-d', config.printerName, '-n', String(copies), pdfPath];
  log.step(`lp ${args.join(' ')}`);
  const { stdout } = await run('lp', args);
  log.done(`Queued: ${stdout.trim()}`);
  return true;
}

/** Convenience for `npm run print -- --printers`: list what CUPS knows about. */
export async function listPrinters(): Promise<string[]> {
  const { stdout } = await run('lpstat', ['-p']).catch(() => ({ stdout: '' }));
  return stdout
    .split('\n')
    .map((line) => line.match(/^printer (\S+)/)?.[1])
    .filter((n): n is string => Boolean(n));
}
