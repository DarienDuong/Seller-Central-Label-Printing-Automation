import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { config } from '../config.js';
import { launchSession, type Session } from '../browser.js';
import { InventoryPage, DEFAULT_THERMAL_MM } from '../pages/inventoryPage.js';
import { sendToPrinter } from '../printer.js';
import { log } from '../logger.js';
import type { LabelFormat, LabelRequest, LabelResult } from '../types.js';

export interface PrintOptions {
  /** Download the PDFs but never touch the printer. */
  dryRun?: boolean;
  /** Force a visible browser window for this run. */
  headed?: boolean;
  /**
   * Opt back into the pre-Phase-5 behavior: one page load per format group,
   * packing every SKU's labels contiguously onto shared sheets. Default is
   * false — one PDF per SKU, fetched directly and merged, so every SKU
   * starts on its own sheet. See docs/PROJECT_CONTEXT.md §7 (Phase 5).
   */
  combine?: boolean;
  /**
   * Reuse an already-launched session (e.g. one that just read a shipment's
   * contents) instead of launching a second one. The caller owns closing it.
   */
  session?: Session;
}

/**
 * Deliberate pause between per-SKU getPdfContent calls (§6: keep the pace
 * human, don't run this as a scraper). A 12-SKU shipment already averages
 * ~263ms/call on its own; this just keeps a burst of many SKUs from reading
 * as a hammering script.
 */
const REQUEST_PACING_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Concatenate whole PDFs — each buffer already ends on its own sheet boundary. */
async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    const doc = await PDFDocument.load(buf);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}

/**
 * Core flow: group requests by format (Seller Central's print-labels page has
 * one shared format/paper control per page load), then for each group
 * navigate once to /fba/printitemlabel/ with every SKU in the group, set
 * each SKU's quantity, submit once, and save the resulting PDF — which
 * covers every SKU in that group.
 *
 * Default (no `options.combine`) fetches each SKU's PDF individually from
 * Seller Central's private getPdfContent endpoint and merges them with
 * pdf-lib, so every SKU starts on its own sheet. `options.combine` opts back
 * into the pre-Phase-5 page-load flow, which packs a group's SKUs onto
 * shared sheets contiguously. See docs/PROJECT_CONTEXT.md §7 (Phase 5) for
 * why Amazon has no native per-SKU sheet-break option.
 *
 * One browser session is reused across all groups; a group that fails is
 * recorded per-SKU and the run continues with the next group.
 */
export async function printLabels(
  requests: LabelRequest[],
  options: PrintOptions = {},
): Promise<LabelResult[]> {
  if (requests.length === 0) return [];

  await mkdir(config.outputDir, { recursive: true });
  const session = options.session ?? (await launchSession({ headed: options.headed }));
  const inventory = new InventoryPage(session.page);
  const results: LabelResult[] = [];

  try {
    // The per-SKU path doesn't need any DOM rows — it just needs the page
    // parked on a Seller Central origin so fetch() carries the authenticated
    // session. One navigation covers every group in this run. Pass a real
    // SKU rather than an empty list: an empty mSku query string never
    // renders the page chrome (kat-button) at all, so openPrintLabelsPage's
    // wait for it times out.
    //
    // This sits in its own try/catch, not inside the per-group loop below,
    // because it happens before any group is processed — a bare throw here
    // would otherwise escape printLabels() entirely (an uncaught exception,
    // zero LabelResults, and a broken `--json` mode) instead of degrading
    // the same way every other failure in this function does: a transient
    // timeout or DOM variant becomes a 'failed' result per request, and the
    // caller still gets a result for every SKU it asked about.
    if (!options.combine) {
      try {
        await inventory.openPrintLabelsPage([requests[0]!.sku]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to open the Print Item Labels page: ${message}`);
        return requests.map((req) => ({ sku: req.sku, status: 'failed', message }));
      }
    }

    // Pacing is tracked across the whole run, not reset per format group —
    // otherwise the last SKU of one group and the first of the next fetch
    // back-to-back with no gap, only pausing *within* a group.
    let fetchedAny = false;

    for (const group of groupByFormat(requests)) {
      const skus = group.map((r) => r.sku);
      const label = `${skus.join(', ')} (${skus.length} SKU${skus.length === 1 ? '' : 's'})`;
      // Tracks which SKUs in this group already have a result, so the catch
      // below (which fires on any throw in this group, including one from
      // sendToPrinter) can't re-record a SKU that was already marked
      // 'skipped' or 'downloaded'/'printed' earlier in the same iteration.
      const recordedInGroup = new Set<string>();
      const record = (result: LabelResult) => {
        recordedInGroup.add(result.sku);
        results.push(result);
      };

      try {
        log.step(`Labeling ${label}`);
        const format = group[0]!.format ?? config.defaultFormat;
        const thermal = { widthMm: group[0]!.thermalWidthMm, heightMm: group[0]!.thermalHeightMm };

        let found: LabelRequest[];
        let pdfPath: string;

        if (options.combine) {
          await inventory.openPrintLabelsPage(skus);

          const rendered = await inventory.renderedSkus();
          found = group.filter((r) => rendered.has(r.sku));
          const missing = group.filter((r) => !rendered.has(r.sku));
          for (const req of missing) {
            record({ sku: req.sku, status: 'skipped', message: 'SKU not found on Print Item Labels page' });
            log.warn(`Skipped ${req.sku}: not found`);
          }
          if (found.length === 0) continue;

          for (const req of found) await inventory.setQuantity(req.sku, req.quantity);
          await inventory.setFormat(format, thermal);

          const download = await inventory.submitAndCapture();
          pdfPath = join(config.outputDir, fileNameFor(found));
          await download.saveAs(pdfPath);
        } else {
          const buffers: Buffer[] = [];
          found = [];
          for (const req of group) {
            if (fetchedAny) await sleep(REQUEST_PACING_MS);
            fetchedAny = true;
            try {
              buffers.push(await inventory.fetchLabelPdf(req.sku, req.quantity, format, thermal));
              found.push(req);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              record({ sku: req.sku, status: 'skipped', message: `SKU not found or API error: ${message}` });
              log.warn(`Skipped ${req.sku}: ${message}`);
            }
          }
          if (found.length === 0) continue;

          pdfPath = join(config.outputDir, fileNameFor(found));
          await writeFile(pdfPath, await mergePdfs(buffers));
        }
        log.done(`Saved ${pdfPath}`);

        // One PDF covers the whole group — print it once, not once per SKU
        // in the loop below. sendToPrinter used to be called per-SKU with
        // the same pdfPath, so an N-SKU group silently printed N copies of
        // the combined PDF (a 12-SKU shipment sent an 82-page PDF 12 times).
        if (options.dryRun) {
          for (const req of found) record({ sku: req.sku, status: 'downloaded', pdfPath, message: 'dry run' });
        } else {
          // The PDF is already saved at this point regardless of what
          // happens next, so a printer failure is recorded per-SKU as
          // 'print-failed' — pdfPath is kept, unlike the outer catch below,
          // which has no PDF to report and would also re-record the
          // 'skipped' SKUs above. 'print-failed' (not 'downloaded') is what
          // keeps this a command failure — see cli.ts's exit code check.
          try {
            const result = await sendToPrinter(pdfPath);
            for (const req of found) {
              record(
                result.sent
                  ? { sku: req.sku, status: 'printed', pdfPath, ...(result.unconfirmed ? { unconfirmed: result.unconfirmed } : {}) }
                  : { sku: req.sku, status: 'downloaded', pdfPath },
              );
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error(`Saved ${pdfPath} but failed to send it to the printer: ${message}`);
            for (const req of found) record({ sku: req.sku, status: 'print-failed', pdfPath, message });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed ${label}: ${message}`);
        for (const req of group) {
          if (!recordedInGroup.has(req.sku)) results.push({ sku: req.sku, status: 'failed', message });
        }
      }
    }
  } finally {
    // Only close a session we launched ourselves — a caller-supplied one is
    // theirs to close (they may still need it after this call returns).
    if (!options.session) await session.close({ save: true });
  }

  return results;
}

/** Requests sharing the same format (and thermal size, if applicable) can be printed together. */
function groupByFormat(requests: LabelRequest[]): LabelRequest[][] {
  const groups = new Map<string, LabelRequest[]>();
  for (const req of requests) {
    const format: LabelFormat = req.format ?? config.defaultFormat;
    const key =
      format === 'thermal'
        ? `thermal:${req.thermalWidthMm ?? DEFAULT_THERMAL_MM.width}x${req.thermalHeightMm ?? DEFAULT_THERMAL_MM.height}`
        : format;
    const group = groups.get(key);
    if (group) group.push(req);
    else groups.set(key, [req]);
  }
  return [...groups.values()];
}

function fileNameFor(group: LabelRequest[]): string {
  const safeSkus = group
    .map((r) => r.sku)
    .join('_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 80);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `labels_${safeSkus}_${stamp}.pdf`;
}
