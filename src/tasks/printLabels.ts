import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { launchSession, type Session } from '../browser.js';
import { InventoryPage } from '../pages/inventoryPage.js';
import { sendToPrinter } from '../printer.js';
import { log } from '../logger.js';
import type { LabelFormat, LabelRequest, LabelResult } from '../types.js';

export interface PrintOptions {
  /** Download the PDFs but never touch the printer. */
  dryRun?: boolean;
  /** Force a visible browser window for this run. */
  headed?: boolean;
  /**
   * Reuse an already-launched session (e.g. one that just read a shipment's
   * contents) instead of launching a second one. The caller owns closing it.
   */
  session?: Session;
}

/**
 * Core flow: group requests by format (Seller Central's print-labels page has
 * one shared format/paper control per page load), then for each group
 * navigate once to /fba/printitemlabel/ with every SKU in the group, set
 * each SKU's quantity, submit once, and save the resulting PDF — which
 * covers every SKU in that group.
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
    for (const group of groupByFormat(requests)) {
      const skus = group.map((r) => r.sku);
      const label = `${skus.join(', ')} (${skus.length} SKU${skus.length === 1 ? '' : 's'})`;

      try {
        log.step(`Labeling ${label}`);
        await inventory.openPrintLabelsPage(skus);

        const rendered = await inventory.renderedSkus();
        const found = group.filter((r) => rendered.has(r.sku));
        const missing = group.filter((r) => !rendered.has(r.sku));
        for (const req of missing) {
          results.push({ sku: req.sku, status: 'skipped', message: 'SKU not found on Print Item Labels page' });
          log.warn(`Skipped ${req.sku}: not found`);
        }
        if (found.length === 0) continue;

        for (const req of found) await inventory.setQuantity(req.sku, req.quantity);
        await inventory.setFormat(group[0]!.format ?? config.defaultFormat, {
          widthMm: group[0]!.thermalWidthMm,
          heightMm: group[0]!.thermalHeightMm,
        });

        const download = await inventory.submitAndCapture();
        const pdfPath = join(config.outputDir, fileNameFor(found));
        await download.saveAs(pdfPath);
        log.done(`Saved ${pdfPath}`);

        for (const req of found) {
          if (options.dryRun) {
            results.push({ sku: req.sku, status: 'downloaded', pdfPath, message: 'dry run' });
          } else {
            const printed = await sendToPrinter(pdfPath);
            results.push({ sku: req.sku, status: printed ? 'printed' : 'downloaded', pdfPath });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed ${label}: ${message}`);
        for (const req of group) results.push({ sku: req.sku, status: 'failed', message });
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
    const key = format === 'thermal' ? `thermal:${req.thermalWidthMm ?? 57}x${req.thermalHeightMm ?? 32}` : format;
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
