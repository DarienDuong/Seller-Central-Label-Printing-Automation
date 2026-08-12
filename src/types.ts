/** Paper layouts Seller Central offers on the Print Item Labels page. */
export type LabelFormat =
  | '30-up'
  | '24-up'
  | '21-up'
  | '27-up'
  | 'thermal-1x2'
  | 'thermal-2x1';

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
}

/** Result of processing a single LabelRequest. */
export interface LabelResult {
  sku: string;
  status: 'printed' | 'downloaded' | 'skipped' | 'failed';
  /** Absolute path to the downloaded PDF, when one was produced. */
  pdfPath?: string;
  message?: string;
}

/** A row scraped out of Manage Inventory, for the `list` command. */
export interface InventoryItem {
  sku: string;
  asin?: string;
  title?: string;
  condition?: string;
  available?: string;
}
