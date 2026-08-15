/**
 * Paper/Sticker Type presets Seller Central offers under "Standard formats" on
 * the Print Item Labels page (/fba/printitemlabel/), plus 'thermal' for the
 * "Thermal printing" mode, which swaps the preset dropdown for freeform
 * Width (mm) / Height (mm) fields instead of a fixed set of sizes.
 */
export type LabelFormat =
  | 'ItemLabel_Letter_30' // 30-up, 1" x 2-5/8", US Letter
  | 'ItemLabel_A4_27' // 27-up, 63.5 x 29.6 mm, A4
  | 'ItemLabel_A4_24' // 24-up, 66 x 33.9 mm, A4
  | 'ItemLabel_A4_21' // 21-up, 63.5 x 38.1 mm, A4
  | 'ItemLabel_A4_40_52x29' // 40-up, 52.5 x 29.7 mm, A4
  | 'ItemLabel_A4_44_48x25' // 44-up, 25.4 x 48.5 mm, A4
  | 'thermal';

/** One line item in a print job: what to label and how many labels to make. */
export interface LabelRequest {
  /** Seller SKU as it appears in Manage Inventory. Preferred lookup key. */
  sku: string;
  /** Optional — only used to sanity-check that we matched the right row. */
  asin?: string;
  /** Optional — logged so a human can eyeball the job before printing. */
  title?: string;
  /** How many labels to print for this SKU. */
  quantity: number;
  /** Overrides DEFAULT_LABEL_FORMAT for this line item. */
  format?: LabelFormat;
  /** Only used when format is 'thermal'. Seller Central defaults to 57 x 32 if omitted. */
  thermalWidthMm?: number;
  thermalHeightMm?: number;
}

/** Result of processing a single LabelRequest. */
export interface LabelResult {
  sku: string;
  /**
   * 'downloaded' means the PDF was saved and printing was never attempted
   * (dry run, or PRINTER_NAME unset). 'print-failed' means the PDF was
   * saved but the printer handoff itself threw — pdfPath is still set, so
   * the artifact isn't lost, but unlike 'downloaded' this counts as a
   * command failure (see cli.ts's exit code check).
   */
  status: 'printed' | 'downloaded' | 'print-failed' | 'skipped' | 'failed';
  /** Absolute path to the downloaded PDF, when one was produced. */
  pdfPath?: string;
  message?: string;
}

/** One SKU inside a Send to Amazon shipment, as shown on its content step. */
export interface ShipmentItem {
  sku: string;
  /** Units being sent — one FNSKU label is needed per unit. */
  units: number;
  /** Boxes the units are split across. Informational; labels go on units. */
  boxes?: number;
}

/** A row scraped out of Manage Inventory, for the `list` command. */
export interface InventoryItem {
  sku: string;
  asin?: string;
  title?: string;
  condition?: string;
  available?: string;
}
