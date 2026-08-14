import type { Page } from 'playwright';
import { gotoAuthed } from '../auth.js';
import { log } from '../logger.js';
import type { ShipmentItem } from '../types.js';

/** Max value in the page's "results per page" dropdown — fewer page turns. */
const MAX_PAGE_SIZE = 100;

/**
 * Page object for the Send to Amazon workflow's "Choose inventory to send"
 * step (/fba/sendtoamazon/confirm_content_step?wf=<workflowId>).
 *
 * Verified 2026-08-13 against a live open shipment. Notes that shaped this:
 *
 * - The step is addressed by *workflow* id (`wf...`), not the FBA shipment id
 *   (`FBA...`). A workflow only gets an FBA id once its shipments are created,
 *   so the workflow id is the right key for an in-progress shipment.
 * - It renders two tabs: "All FBA SKUs" (every FBA SKU, quantity fields empty)
 *   and "SKUs ready to send (N)" (just this shipment's contents). Only the
 *   second is meaningful here — reading the default tab yields every SKU in
 *   the catalogue with no quantities.
 * - On the ready-to-send tab quantities are rendered as *text*
 *   ("Units: 198" / "Boxes: 33"), not form inputs.
 * - The list paginates (default 25/page). Shipments of 30–60 SKUs are normal,
 *   so page size is raised and every page is walked; the scraped count is then
 *   checked against the widget's own `total-items` so a partial read fails
 *   loudly instead of silently printing labels for a subset.
 * - The page is slow — 15–20s to first paint is normal — hence the long waits.
 */
export class ShipmentPage {
  constructor(private readonly page: Page) {}

  /** Open the workflow's content step and switch to its ready-to-send contents. */
  async open(workflowId: string): Promise<void> {
    await gotoAuthed(this.page, '/fba/sendtoamazon/confirm_content_step', { wf: workflowId });

    // Wait for the SKU table itself, not just the shell.
    await this.page
      .locator('kat-pagination[data-testid="sku-paging"]')
      .waitFor({ state: 'attached', timeout: 90_000 })
      .catch(() => {
        throw new Error(
          `Shipment workflow ${workflowId} did not load. Check the id, or that the workflow still exists.`,
        );
      });

    await this.selectReadyToSendTab();
    await this.setPageSize(MAX_PAGE_SIZE);
  }

  /** Switch to the "SKUs ready to send (N)" tab — a view filter, nothing is mutated. */
  private async selectReadyToSendTab(): Promise<void> {
    const tab = this.page.getByText(/SKUs ready to send/i).first();
    if ((await tab.count()) === 0) {
      throw new Error('Could not find the "SKUs ready to send" tab on the shipment page.');
    }
    await tab.click();
    await this.page.waitForTimeout(5_000);
  }

  /** Raise the results-per-page dropdown so most shipments fit on one page. */
  private async setPageSize(size: number): Promise<void> {
    const dropdown = this.page.locator('kat-dropdown').filter({ hasText: /results per page/i }).first();
    if ((await dropdown.count()) === 0) return;
    await dropdown.click().catch(() => {});
    await this.page
      .locator('kat-option')
      .filter({ hasText: new RegExp(`^${size} results per page`) })
      .first()
      .click()
      .catch(() => {});
    await this.page.waitForTimeout(5_000);
  }

  /** Total SKUs in this shipment, per the pagination widget's own count. */
  private async totalItems(): Promise<number | null> {
    const raw = await this.page
      .locator('kat-pagination[data-testid="sku-paging"]')
      .first()
      .getAttribute('total-items')
      .catch(() => null);
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) ? n : null;
  }

  /** Scrape the SKU rows visible on the current page. */
  private async rowsOnPage(): Promise<ShipmentItem[]> {
    await this.page
      .locator('.sku-row-sku-details')
      .first()
      .waitFor({ state: 'attached', timeout: 30_000 })
      .catch(() => {});

    return this.page.evaluate(() => {
      const items: { sku: string; units: number; boxes?: number }[] = [];
      document.querySelectorAll('.sku-row-sku-details').forEach((detail) => {
        const row = detail.closest('[class*="sku-row"]')?.parentElement ?? detail.parentElement;
        const text = (row as HTMLElement | null)?.innerText ?? '';
        const sku = text.match(/SKU:\s*([^\s\n]+)/)?.[1];
        // "Units: 1,933" — strip separators before parsing.
        const units = Number.parseInt((text.match(/Units:\s*([\d,]+)/)?.[1] ?? '').replace(/,/g, ''), 10);
        const boxes = Number.parseInt((text.match(/Boxes:\s*([\d,]+)/)?.[1] ?? '').replace(/,/g, ''), 10);
        if (!sku || !Number.isFinite(units)) return;
        items.push({ sku, units, ...(Number.isFinite(boxes) ? { boxes } : {}) });
      });
      return items;
    });
  }

  /**
   * Every SKU in the shipment with the number of units being sent.
   * Throws if the scrape is incomplete rather than returning a partial list —
   * printing labels for a subset of a shipment is worse than failing.
   */
  async readyToSendItems(): Promise<ShipmentItem[]> {
    const total = await this.totalItems();
    const collected = new Map<string, ShipmentItem>();

    for (let page = 1; page <= 50; page++) {
      for (const item of await this.rowsOnPage()) collected.set(item.sku, item);
      if (total !== null && collected.size >= total) break;
      if (!(await this.goToNextPage())) break;
    }

    const items = [...collected.values()];
    if (total !== null && items.length !== total) {
      throw new Error(
        `Read ${items.length} of ${total} SKUs from the shipment — refusing to print a partial shipment. ` +
          `The page may still have been loading; retry, or use --headed to watch.`,
      );
    }
    if (items.length === 0) throw new Error('No ready-to-send SKUs found in this shipment.');
    return items;
  }

  /** Advance the SKU pager one page. Returns false when there is no next page. */
  private async goToNextPage(): Promise<boolean> {
    const next = this.page
      .locator('kat-pagination[data-testid="sku-paging"]')
      .getByRole('button', { name: /next/i })
      .first();

    if ((await next.count()) === 0 || (await next.isDisabled().catch(() => true))) return false;

    await next.click().catch(() => {});
    await this.page.waitForTimeout(5_000);
    log.info('Advanced to the next page of shipment SKUs…');
    return true;
  }
}

/**
 * Accept either a bare workflow id or a pasted Send to Amazon URL.
 * Seller Central shows the URL far more often than the raw id, so pasting
 * the whole thing is the common case.
 */
export function parseWorkflowId(input: string): string {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/[?&]wf=([^&\s]+)/)?.[1];
  const id = fromUrl ?? trimmed;
  if (!/^wf[0-9a-f-]{8,}$/i.test(id)) {
    throw new Error(
      `"${input}" is not a Send to Amazon workflow id. Expected something like ` +
        `wf7f067182-69c7-4aa8-bb32-5c3cdee02ba5, or the full confirm_content_step URL.`,
    );
  }
  return id;
}
