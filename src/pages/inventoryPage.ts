import type { Download, Page } from 'playwright';
import { gotoAuthed } from '../auth.js';
import type { InventoryItem, LabelFormat } from '../types.js';

/**
 * Page object for Manage Inventory and the Print Item Labels flow.
 *
 * Verified 2026-08-12 against a live account. Seller Central's inventory grid
 * (Manage All Inventory) is a heavily shadow-DOM'd Katal ("kat-*") component
 * with no real <table>/<tr> elements, so it's only used here for the `list`
 * command. Printing labels never touches that grid: Seller Central exposes a
 * dedicated page, /fba/printitemlabel/?mSku.0=<sku>&mSku.1=<sku>..., that
 * accepts a batch of SKUs directly in the URL and renders one row per SKU
 * with its own quantity field — far more reliable than driving the grid's
 * row action menu. Unknown/invalid SKUs are silently dropped from that page
 * (no error), so callers must diff requested vs. rendered SKUs to detect
 * "not found".
 */
export class InventoryPage {
  constructor(private readonly page: Page) {}

  /** Manage Inventory, filtered to nothing. */
  async open(): Promise<void> {
    await gotoAuthed(this.page, '/myinventory/inventory');
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** Type a SKU/ASIN into the inventory search box and wait for the grid. */
  async search(query: string): Promise<void> {
    // getByPlaceholder matches both the kat-input host and the native input
    // in its shadow root (both carry the placeholder attribute) — a strict
    // mode violation. Target the shadow-internal input directly instead.
    const box = this.page.locator(
      'kat-input[placeholder="Search SKU, Title/Keyword, FNSKU, ASIN, UPC/EAN"] input',
    );
    await box.click();
    await box.fill(query);
    await box.press('Enter');
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /**
   * Scrape the visible page of the grid — backs the `list` command.
   * Verified 2026-08-12: each row's innerText is a flat list of label/value
   * lines — "ASIN", <asin>, "SKU", <sku>, "FNSKU", <fnsku>, ... "Available",
   * <count>, ... — so values are pulled by looking up the line right after
   * their label, not by pattern guessing (a plain regex over the lines
   * previously matched "Active" as a fake SKU). Title sits right *before*
   * "ASIN", not at a fixed line index — an "Out of stock" row has an extra
   * "Replenish inventory" action line before it that a fixed index misses.
   */
  async listVisible(): Promise<InventoryItem[]> {
    // Rows are an async render on top of the grid shell — same race as
    // renderedSkus() on the print-labels page. A genuinely empty result set
    // just times out here and returns [].
    await this.page
      .locator('[class*="tableContentRow"]')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => {});

    const rows = this.page.locator('[class*="tableContentRow"]');
    const count = await rows.count();
    const items: InventoryItem[] = [];

    for (let i = 0; i < count; i++) {
      const text = (await rows.nth(i).innerText().catch(() => '')).trim();
      const lines = text.split('\n').map((line) => line.trim());
      const after = (label: string) => {
        const idx = lines.indexOf(label);
        return idx >= 0 ? lines[idx + 1] : undefined;
      };
      const before = (label: string) => {
        const idx = lines.indexOf(label);
        return idx > 0 ? lines[idx - 1] : undefined;
      };

      const sku = after('SKU');
      if (!sku) continue;
      items.push({ sku, asin: after('ASIN'), title: before('ASIN'), available: after('Available') });
    }
    return items;
  }

  /**
   * Navigate straight to the Print Item Labels page for a batch of SKUs.
   * One page covers the whole batch: shared format/paper controls, one
   * quantity field per SKU, one Print click, one PDF.
   */
  async openPrintLabelsPage(skus: string[]): Promise<void> {
    const params: Record<string, string> = {};
    skus.forEach((sku, i) => {
      params[`mSku.${i}`] = sku;
    });
    await gotoAuthed(this.page, '/fba/printitemlabel/', params);
    // The form is a client-rendered Katal web component tree — wait for the
    // submit button (page chrome, present regardless of how many SKUs matched)
    // rather than racing evaluateAll() against domcontentloaded.
    await this.page.locator('kat-button[label="Print Item Labels"]').waitFor({ state: 'attached' });
  }

  /** SKUs Seller Central actually rendered a row for (unknown SKUs are dropped, not errored). */
  async renderedSkus(): Promise<Set<string>> {
    // kat-button (page chrome) attaches immediately; the per-SKU rows are an
    // async fetch on top of that, so give them a bounded wait too. A true
    // zero-matches batch just times out here and returns an empty set.
    await this.page
      .locator('kat-input[type="number"][id]')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => {});

    const ids = await this.page
      .locator('kat-input[type="number"][id]')
      .evaluateAll((els) => els.map((el) => el.id).filter(Boolean));
    return new Set(ids);
  }

  /** Set how many labels to generate for one SKU already on the print-labels page. */
  async setQuantity(sku: string, quantity: number): Promise<void> {
    const input = this.page.locator(`kat-input[id="${escapeAttr(sku)}"] input`);
    await input.fill(String(quantity));
  }

  /** Choose Standard vs. Thermal and the specific paper/size. */
  async setFormat(format: LabelFormat, thermal?: { widthMm?: number; heightMm?: number }): Promise<void> {
    const isThermal = format === 'thermal';
    await this.chooseDropdownOption('Choose printing format', isThermal ? 'Thermal printing' : 'Standard formats');

    if (isThermal) {
      const widthMm = thermal?.widthMm ?? 57;
      const heightMm = thermal?.heightMm ?? 32;
      await this.page.locator('kat-input[label="Width (mm)"] input').fill(String(widthMm));
      await this.page.locator('kat-input[label="Height (mm)"] input').fill(String(heightMm));
    } else {
      await this.chooseDropdownOption('Paper/Sticker Type', STANDARD_FORMAT_LABELS[format]);
    }
  }

  /** Open a kat-dropdown by its label and click the option with matching text. */
  private async chooseDropdownOption(dropdownLabel: string, optionText: string): Promise<void> {
    await this.page.locator(`kat-dropdown[label="${escapeAttr(dropdownLabel)}"]`).click();
    await this.page.locator('kat-option').filter({ hasText: optionText }).first().click();
  }

  /**
   * Click Print and capture the generated PDF.
   * Seller Central either triggers a download or opens the PDF in a new tab;
   * both paths are handled so the caller always gets a Download.
   */
  async submitAndCapture(): Promise<Download> {
    const downloadPromise = this.page.waitForEvent('download', { timeout: 60_000 });
    const popupPromise = this.page.context().waitForEvent('page', { timeout: 60_000 }).catch(() => null);

    await this.page.locator('kat-button[label="Print Item Labels"]').click();

    const popup = await Promise.race([downloadPromise.then(() => null), popupPromise]);

    if (popup) {
      // PDF opened in a tab — pull it through the same download plumbing.
      const popupDownload = popup.waitForEvent('download', { timeout: 30_000 });
      await popup.close().catch(() => {});
      return popupDownload;
    }
    return downloadPromise;
  }
}

/** Escape a value for interpolation into a CSS attribute-selector string literal. */
function escapeAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** Visible option text in the Paper/Sticker Type dropdown, keyed by our enum. */
const STANDARD_FORMAT_LABELS: Record<Exclude<LabelFormat, 'thermal'>, string> = {
  ItemLabel_Letter_30: '30-up labels 1" x 2 5/8" on US Letter',
  ItemLabel_A4_27: '27-up labels 63.5 x 29.6 mm on A4',
  ItemLabel_A4_24: '24-up labels 66 x 33.9 mm on A4',
  ItemLabel_A4_21: '21-up labels 63.5 x 38.1 mm on A4',
  ItemLabel_A4_40_52x29: '40-up labels 52.5 x 29.7 mm on A4',
  ItemLabel_A4_44_48x25: '44-up labels (25.4 mm x 48.5 mm) on A4',
};
