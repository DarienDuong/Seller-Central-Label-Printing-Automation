import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { launchSession } from '../browser.js';
import { InventoryPage } from '../pages/inventoryPage.js';
import { sendToPrinter } from '../printer.js';
import { log } from '../logger.js';
import type { LabelRequest, LabelResult } from '../types.js';

export interface PrintOptions {
  /** Download the PDFs but never touch the printer. */
  dryRun?: boolean;
  /** Force a visible browser window for this run. */
  headed?: boolean;
}

/**
 * Core flow: for each requested SKU, generate its item labels in Seller
 * Central, save the PDF, and optionally send it to the printer.
 *
 * One browser session is reused across all requests — logging in is the slow
 * part, and Amazon dislikes repeated fresh sessions.
 */
export async function printLabels(
  requests: LabelRequest[],
  options: PrintOptions = {},
): Promise<LabelResult[]> {
  if (requests.length === 0) return [];

  await mkdir(config.outputDir, { recursive: true });
  const session = await launchSession({ headed: options.headed });
  const inventory = new InventoryPage(session.page);
  const results: LabelResult[] = [];

  try {
    await inventory.open();

    for (const req of requests) {
      const label = `${req.sku} ×${req.quantity}`;
      try {
        log.step(`Labeling ${label}${req.title ? ` — ${req.title}` : ''}`);

        await inventory.search(req.sku);
        if (!(await inventory.rowExists(req.sku))) {
          results.push({ sku: req.sku, status: 'skipped', message: 'SKU not found in Manage Inventory' });
          log.warn(`Skipped ${req.sku}: not found`);
          continue;
        }

        await inventory.openPrintLabels(req.sku);
        await inventory.setQuantity(req.quantity);
        await inventory.setFormat(req.format ?? config.defaultFormat);

        const download = await inventory.submitAndCapture();
        const pdfPath = join(config.outputDir, fileNameFor(req));
        await download.saveAs(pdfPath);
        log.done(`Saved ${pdfPath}`);

        if (options.dryRun) {
          results.push({ sku: req.sku, status: 'downloaded', pdfPath, message: 'dry run' });
        } else {
          const printed = await sendToPrinter(pdfPath);
          results.push({ sku: req.sku, status: printed ? 'printed' : 'downloaded', pdfPath });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed ${label}: ${message}`);
        results.push({ sku: req.sku, status: 'failed', message });
        // Reset to a known-good state so one bad SKU doesn't sink the batch.
        await inventory.open().catch(() => {});
      }
    }
  } finally {
    await session.close({ save: true });
  }

  return results;
}

function fileNameFor(req: LabelRequest): string {
  const safeSku = req.sku.replace(/[^A-Za-z0-9._-]+/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `labels_${safeSku}_x${req.quantity}_${stamp}.pdf`;
}
