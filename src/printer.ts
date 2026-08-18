import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { createRequire } from 'node:module';
import type { PrintOptions } from 'pdf-to-printer';
import { config } from './config.js';
import { log } from './logger.js';

// `pdf-to-printer` ships as CJS, and Node's static named-export detection
// for CJS modules loaded via `import { ... } from` is best-effort — it
// picked up `print` but not `getPrinters`, throwing "does not provide an
// export named 'getPrinters'" at module load. A real CJS `require` (via
// `createRequire`) sidesteps that static analysis entirely and always sees
// the whole `module.exports` object, so it can't have this problem; types
// come from a type-only import instead, which doesn't touch the runtime
// binding and so doesn't hit the same interop issue.
const require = createRequire(import.meta.url);
const pdfToPrinter = require('pdf-to-printer') as {
  print: (pdf: string, options?: PrintOptions) => Promise<void>;
};
const { print: printPdfWindows } = pdfToPrinter;

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
// There's no Windows equivalent of `lp -d <printer>`. Two earlier versions
// of this tried to route around that gap and both depended on whatever PDF
// viewer happened to be registered on the machine:
//   1. The registered PDF handler's "Print" shell verb
//      (`Start-Process -Verb Print`) — assumed to resolve to Edge (on every
//      Windows box), but on the machine that actually surfaced the bug it
//      was Acrobat Reader. Either way, that verb pops its own print dialog
//      instead of printing silently, so every run needed a human to click
//      "Print" in a popup — the opposite of automated.
//   2. A manually-downloaded, unmanaged copy of SumatraPDF.exe, shelled out
//      to directly. That fixed the popup, but pushed a step onto every
//      teammate's setup that lives outside `npm install` — not a project
//      dependency, easy to end up on the wrong PATH, and one more thing to
//      go stale silently.
//
// This uses the `pdf-to-printer` npm package for the actual print: it
// bundles its own copy of SumatraPDF *inside the package*, so `npm install`
// is the only setup step (same as everything else in this repo), and it
// drives that bundled binary directly rather than whatever's registered as
// the system's PDF handler — so it isn't at the mercy of a teammate's Edge
// vs. Acrobat vs. anything-else default. `print()` targets a printer by
// name (`-print-to`, silent by default) and its promise only resolves once
// the job has been handed to the bundled Sumatra process, so a clean
// resolve *is* the confirmation — no default-printer juggling, no
// queue-polling.
//
// Printer *listing/resolution*, though, deliberately does NOT use the same
// package's `getPrinters()` — it has a real, unfixed upstream bug
// (artiebits/pdf-to-printer#484, open since 2025, several people still
// hitting it with no workaround offered). It parses `Get-CimInstance`'s
// PowerShell console output by splitting each line on `:`; when a
// printer's `PrinterPaperNames` list is long enough to wrap onto a
// continuation line with no colon on it (routine for real printers with
// many supported paper sizes — this is what happened with the printer this
// was tested against), that line's `value` comes back `undefined` and its
// `.match(...)` call throws `Cannot read properties of undefined (reading
// 'match')`. `print()` itself doesn't go through that parser at all, so
// only listing was affected. Simplest fix: query just the printer name
// ourselves — `-ExpandProperty Name` prints one bare name per line, with
// nothing else to wrap or mis-parse.
//
// Everything here is deliberately loud on failure. The CUPS path gets that
// for free (`lp` exits non-zero on a bad `-d`); `resolvePrinterWindows`
// below gives Windows the same property by validating PRINTER_NAME against
// the installed printers before ever calling `print()`.

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function queryPrinterNamesWindows(): Promise<string[]> {
  const { stdout } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance -ClassName Win32_Printer | Select-Object -ExpandProperty Name',
  ]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Resolve PRINTER_NAME to the exact string Windows uses for it
 * (case-insensitive, same as Windows itself) — so a typo'd or stale `.env`
 * value fails loudly here, before `print()` is ever called, rather than
 * SumatraPDF silently doing something unexpected with an unrecognized
 * printer argument.
 */
async function resolvePrinterWindows(name: string): Promise<string> {
  const names = await queryPrinterNamesWindows();
  const match = names.find((n) => n.toLowerCase() === name.toLowerCase());
  if (!match) {
    throw new Error(
      `No Windows printer matches PRINTER_NAME "${name}". Run \`npm run print -- --printers\` and copy the name exactly.`,
    );
  }
  return match;
}

async function sendToPrinterWindows(pdfPath: string, copies: number): Promise<SendResult> {
  const target = await resolvePrinterWindows(config.printerName);

  log.step(`Printing ${copies} cop${copies === 1 ? 'y' : 'ies'} of ${pdfPath} to "${target}" via pdf-to-printer`);
  try {
    await printPdfWindows(pdfPath, { printer: target, copies, silent: true });
  } catch (err) {
    throw new Error(`pdf-to-printer failed to print "${pdfPath}" to "${target}": ${errText(err)}`);
  }

  log.done(`Sent ${copies} job(s) to ${target}.`);
  return { sent: true };
}

async function listPrintersWindows(): Promise<string[]> {
  return queryPrinterNamesWindows().catch((err: unknown) => {
    log.warn(`Could not query Windows printers — list may be incomplete: ${errText(err)}`);
    return [];
  });
}
