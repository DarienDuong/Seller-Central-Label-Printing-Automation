import type { Page } from 'playwright';
import { gotoAuthed } from '../auth.js';
import { log } from '../logger.js';
import type { ShipmentItem } from '../types.js';

const PAGER = 'kat-pagination[data-testid="sku-paging"]';

/**
 * Rows per page to request. The dropdown offers 10/25/50/100 — 100 keeps most
 * shipments on a single page. Overridable via SHIPMENT_PAGE_SIZE purely as a
 * debug knob: setting it low is the only practical way to exercise the
 * multi-page path against a shipment that would otherwise fit on one page.
 */
const MAX_PAGE_SIZE = 100;
const PAGE_SIZE = Number.parseInt(process.env.SHIPMENT_PAGE_SIZE ?? '', 10) || MAX_PAGE_SIZE;

/** How long to wait for the pager to reflect a tab/page-size/page change. */
const SETTLE_TIMEOUT_MS = 30_000;

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
 * - The page is slow — 15–20s to first paint is normal.
 *
 * Pagination on this tab does not work the way it first appears, which
 * matters a lot for correctness (verified against a live shipment):
 *
 * - On the ready-to-send tab the pager's `total-items` is the number of rows
 *   *currently rendered*, not the shipment total. At 10 rows/page a 12-SKU
 *   shipment reports `total-items=10`. (On the All-FBA tab it does report the
 *   true total.) So `total-items` is useless as a completeness check here —
 *   trusting it would let a short read pass silently.
 * - Because it reports total == page size, the pager concludes there is one
 *   page and renders no next/prev controls at all — there is nothing to click
 *   through to page 2.
 * - The trustworthy total is the tab's own label, "SKUs ready to send (N)".
 *
 * So the strategy is: read N from the tab label, ask for the largest page
 * size Amazon offers (100) so every row is on one page, and require exactly N
 * rows before returning. A shipment larger than 100 ready-to-send SKUs can't
 * be read this way and fails loudly rather than silently truncating.
 *
 * Every state change waits on an observable condition rather than a fixed
 * sleep, so a scrape can't run against the wrong tab or a half-rendered one.
 */
export class ShipmentPage {
  constructor(private readonly page: Page) {}

  /** SKU count parsed from the "SKUs ready to send (N)" tab label. */
  private expectedFromTab: number | null = null;

  /** Open the workflow's content step and switch to its ready-to-send contents. */
  async open(workflowId: string): Promise<void> {
    await gotoAuthed(this.page, '/fba/sendtoamazon/confirm_content_step', { wf: workflowId });

    // Wait for the SKU table itself, not just the shell.
    await this.page
      .locator(PAGER)
      .waitFor({ state: 'attached', timeout: 90_000 })
      .catch(() => {
        throw new Error(
          `Shipment workflow ${workflowId} did not load. Check the id, or that the workflow still exists.`,
        );
      });

    // Page size first, then the tab. Changing the page size re-queries the
    // list and resets it to the default "All FBA SKUs" tab, so doing it after
    // the tab switch silently throws away the switch — observed live as
    // "Read 1 of 1429 SKUs" (1429 being the whole catalogue).
    await this.setPageSize(PAGE_SIZE);
    await this.selectReadyToSendTab();

  }

  /** Switch to the "SKUs ready to send (N)" tab — a view filter, nothing is mutated. */
  private async selectReadyToSendTab(): Promise<void> {
    // Scoped to kat-tab: an unscoped getByText would also match a banner or
    // tooltip carrying the same phrase and click the wrong thing.
    const tab = this.page.locator('kat-tab').filter({ hasText: /SKUs ready to send/i }).first();
    if ((await tab.count()) === 0) {
      throw new Error('Could not find the "SKUs ready to send" tab on the shipment page.');
    }

    const label = await tab.innerText().catch(() => '');
    const parsed = Number.parseInt((label.match(/\((\d[\d,]*)\)/)?.[1] ?? '').replace(/,/g, ''), 10);
    this.expectedFromTab = Number.isFinite(parsed) ? parsed : null;

    if (this.expectedFromTab === null) {
      log.warn('Could not read a SKU count from the tab label; the completeness check will be skipped.');
    }

    // Retried because the click can land mid-re-render (the page-size change
    // just above re-queries the list) and silently not register, which looks
    // identical to a slow load. "Switched" means shipment rows are actually
    // present — All-FBA rows carry no "Units:" value, so a non-empty
    // extraction is proof we're on the right tab.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await tab.click().catch(() => {});
      const switched = await this.waitFor(async () => (await this.extractRows()).length > 0, 15_000);
      if (switched) return;
      log.warn(`The SKU list didn't switch to the shipment's contents (attempt ${attempt}/3); retrying…`);
    }

    throw new Error(
      'Could not switch to the shipment\'s "SKUs ready to send" contents. ' +
        'The page may still be loading — retry, or use --headed to watch.',
    );
  }

  /** Raise the results-per-page dropdown so most shipments fit on one page. */
  private async setPageSize(size: number): Promise<void> {
    const dropdown = this.page.locator('kat-dropdown[data-testid="page-size-dropdown"]');
    if ((await dropdown.count()) === 0) {
      log.warn('No results-per-page control found; paging through at the default size.');
      return;
    }

    try {
      await dropdown.click();
      // Scope the option to *this* dropdown and match on its value attribute.
      // An unscoped `kat-option` locator picks from ~76 options across the
      // page's other dropdowns, lands on one inside a closed dropdown, and
      // then blocks until the action timeout — which is exactly how this
      // silently degraded to the default page size before.
      await dropdown.locator(`kat-option[value="${size}"]`).first().click();
    } catch (err) {
      // Say so rather than swallowing it: this tab has no next-page control,
      // so a page size smaller than the shipment means an unreadable
      // shipment, and the only other symptom would be a confusing shortfall.
      log.warn(`Could not select "${size} results per page" (${errText(err)}); using the default page size.`);
      return;
    }

    const applied = await this.waitFor(async () => (await this.pagerAttr('items-per-page')) === String(size));
    if (!applied) log.warn(`Page size did not change to ${size}; the shipment may not fit on one page.`);
  }

  /** Read one attribute off the pager. */
  private async pagerAttr(name: string): Promise<string | null> {
    return this.page.locator(PAGER).first().getAttribute(name).catch(() => null);
  }

  /** Poll `check` until it's true or the timeout elapses. */
  private async waitFor(check: () => Promise<boolean>, timeout = SETTLE_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await check().catch(() => false)) return true;
      if (Date.now() >= deadline) return false;
      await this.page.waitForTimeout(500);
    }
  }

  /**
   * Scrape the SKU rows visible on the current page.
   *
   * Rows here read as "SKU: 00-CYS0-9GM6" — label and value on one line —
   * so values are pulled with label-anchored regexes. (This is a different
   * text shape from Manage Inventory, where the label and its value sit on
   * separate lines and `listVisible()` therefore indexes by line instead.)
   */
  private async rowsOnPage(expectedRows: number | null): Promise<ShipmentItem[]> {
    await this.page
      .locator('.sku-row-sku-details')
      .first()
      .waitFor({ state: 'attached', timeout: 30_000 })
      .catch(() => {});

    // Rows paint progressively, and the other tab's rows sit in the DOM too —
    // so counting `.sku-row-sku-details` is a bad proxy for readiness (it's
    // satisfied by the hidden All-FBA rows while ready-to-send rows are still
    // arriving, which showed up live as "Read 1 of 12"). Poll the real
    // extraction instead: it only counts rows that actually carry a SKU and a
    // "Units:" value, which is exactly what we're waiting for.
    if (expectedRows !== null && expectedRows > 0) {
      await this.waitFor(async () => (await this.extractRows()).length >= expectedRows);
    }
    return this.extractRows();
  }

  /** Parse the SKU rows currently in the DOM. Rows mid-render simply don't match yet. */
  private async extractRows(): Promise<ShipmentItem[]> {
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
    const expected = this.expectedFromTab;
    const items = await this.rowsOnPage(expected);

    if (items.length === 0) throw new Error('No ready-to-send SKUs found in this shipment.');
    if (expected === null) {
      log.warn(`Read ${items.length} SKUs, but the shipment's own SKU count was unreadable — verify before printing.`);
      return items;
    }

    if (items.length !== expected) {
      // This tab has no working next-page control (see the class notes), so a
      // shortfall is terminal rather than something to page past.
      throw new Error(
        `Read ${items.length} of ${expected} SKUs from the shipment — refusing to print a partial shipment. ` +
          (expected > PAGE_SIZE
            ? `They don't fit on one page of ${PAGE_SIZE}, and this tab exposes no next-page control` +
              (PAGE_SIZE < MAX_PAGE_SIZE
                ? ` — raise SHIPMENT_PAGE_SIZE (max ${MAX_PAGE_SIZE}).`
                : `, which is the largest page Seller Central offers. Print it in parts with --file instead.`)
            : 'The page may still have been loading; retry, or use --headed to watch.'),
      );
    }
    return items;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0]! : String(err);
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
