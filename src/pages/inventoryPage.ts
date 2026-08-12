import type { Download, Locator, Page } from 'playwright';
import { gotoAuthed } from '../auth.js';
import { log } from '../logger.js';
import type { InventoryItem, LabelFormat } from '../types.js';

/**
 * Page object for Manage Inventory and the Print Item Labels flow.
 *
 * ⚠️ Seller Central's DOM is unstable and differs by account, marketplace, and
 * A/B bucket. Every selector below is a first guess captured from the public
 * UI — verify each one against the real account (run headed with SLOW_MO set)
 * and replace it with something anchored to visible text or a data-* attribute
 * rather than a generated class name.
 */
export class InventoryPage {
  constructor(private readonly page: Page) {}

  /** Manage Inventory, filtered to nothing. */
  async open(): Promise<void> {
    await gotoAuthed(this.page, '/inventory');
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** Type a SKU/ASIN into the inventory search box and wait for the grid. */
  async search(query: string): Promise<void> {
    // TODO(selectors): verify — search box has changed names several times.
    const box = this.page
      .getByPlaceholder(/search/i)
      .or(this.page.locator('#myitable-search-input, input[name="searchText"]'))
      .first();

    await box.click();
    await box.fill(query);
    await box.press('Enter');
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** The grid row matching a SKU exactly. */
  row(sku: string): Locator {
    // TODO(selectors): verify — prefer a row-scoped locator over nth-child.
    return this.page
      .locator('tr, [role="row"]')
      .filter({ hasText: sku })
      .first();
  }

  async rowExists(sku: string): Promise<boolean> {
    return (await this.row(sku).count()) > 0;
  }

  /** Scrape the visible page of the grid — backs the `list` command. */
  async listVisible(): Promise<InventoryItem[]> {
    // TODO(selectors): map real column indexes once the grid is confirmed.
    const rows = this.page.locator('[role="row"]');
    const count = await rows.count();
    const items: InventoryItem[] = [];

    for (let i = 0; i < count; i++) {
      const cells = rows.nth(i).locator('[role="cell"], td');
      if ((await cells.count()) < 3) continue;
      const text = async (n: number) => (await cells.nth(n).innerText().catch(() => '')).trim();
      const sku = await text(2);
      if (!sku) continue;
      items.push({ sku, title: await text(1), available: await text(await cells.count() - 1) });
    }
    return items;
  }

  /**
   * Open the row's action menu and choose "Print item labels".
   * Returns once the label form is visible (it may be a modal or a new page).
   */
  async openPrintLabels(sku: string): Promise<void> {
    const row = this.row(sku);
    if ((await row.count()) === 0) throw new Error(`SKU not found in grid: ${sku}`);

    // TODO(selectors): the caret is an unlabeled button in the Edit split-button.
    await row.getByRole('button', { name: /edit|actions/i }).first().click();
    await this.page.getByRole('menuitem', { name: /print item labels/i })
      .or(this.page.getByRole('link', { name: /print item labels/i }))
      .first()
      .click();

    await this.labelForm().waitFor({ state: 'visible' });
  }

  /** The Print Item Labels form, whether it renders inline or in a dialog. */
  labelForm(): Locator {
    // TODO(selectors): verify container.
    return this.page.locator('[role="dialog"], form#label-print-form, #print-labels').first();
  }

  /** Set how many labels to generate. */
  async setQuantity(quantity: number): Promise<void> {
    const input = this.labelForm()
      .getByLabel(/number of labels|quantity/i)
      .or(this.labelForm().locator('input[type="number"], input[name*="quantity" i]'))
      .first();
    await input.fill(String(quantity));
  }

  /** Choose the paper/thermal layout. */
  async setFormat(format: LabelFormat): Promise<void> {
    const select = this.labelForm()
      .getByLabel(/label (type|size)|paper/i)
      .or(this.labelForm().locator('select'))
      .first();

    if ((await select.count()) === 0) {
      log.warn(`No label-format control found; leaving Seller Central's default (wanted ${format}).`);
      return;
    }
    await select.selectOption({ label: FORMAT_LABELS[format] }).catch(async () => {
      log.warn(`Could not select "${FORMAT_LABELS[format]}" — check FORMAT_LABELS against the live dropdown.`);
    });
  }

  /**
   * Click Print and capture the generated PDF.
   * Seller Central either triggers a download or opens the PDF in a new tab;
   * both paths are handled so the caller always gets a Download.
   */
  async submitAndCapture(): Promise<Download> {
    const downloadPromise = this.page.waitForEvent('download', { timeout: 60_000 });
    const popupPromise = this.page.context().waitForEvent('page', { timeout: 60_000 }).catch(() => null);

    await this.labelForm().getByRole('button', { name: /^print$|print labels/i }).first().click();

    const popup = await Promise.race([
      downloadPromise.then(() => null),
      popupPromise,
    ]);

    if (popup) {
      // PDF opened in a tab — pull it through the same download plumbing.
      const popupDownload = popup.waitForEvent('download', { timeout: 30_000 });
      await popup.close().catch(() => {});
      return popupDownload;
    }
    return downloadPromise;
  }
}

/** Visible option text in the label-format dropdown, keyed by our enum. */
const FORMAT_LABELS: Record<LabelFormat, string> = {
  // TODO(selectors): copy the exact option strings out of the live dropdown.
  '30-up': '30 labels per page (2-5/8" x 1")',
  '24-up': '24 labels per page (2" x 1")',
  '21-up': '21 labels per page (2-5/8" x 1")',
  '27-up': '27 labels per page (2" x 1")',
  'thermal-1x2': 'Thermal printing 1" x 2-1/8"',
  'thermal-2x1': 'Thermal printing 2" x 1"',
};
