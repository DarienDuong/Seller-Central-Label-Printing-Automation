import { z } from 'zod';

/**
 * Mirrors src/types.ts's LabelFormat. Zod has no way to derive a runtime
 * schema from a plain TS union, so this list has to be kept in sync by hand
 * — if LabelFormat's members change, update both.
 */
export const LabelFormatSchema = z.enum([
  'ItemLabel_Letter_30',
  'ItemLabel_A4_27',
  'ItemLabel_A4_24',
  'ItemLabel_A4_21',
  'ItemLabel_A4_40_52x29',
  'ItemLabel_A4_44_48x25',
  'thermal',
]);

/** Mirrors src/types.ts's LabelRequest. */
export const LabelRequestSchema = z.object({
  sku: z.string().min(1).describe('Seller SKU as it appears in Manage Inventory.'),
  asin: z.string().optional().describe('Optional sanity check that the right row was matched.'),
  title: z.string().optional().describe('Optional, logged only — not sent to Seller Central.'),
  quantity: z.number().int().positive().describe('How many labels to print for this SKU.'),
  format: LabelFormatSchema.optional().describe('Overrides the default label format for this line item.'),
  thermalWidthMm: z.number().positive().optional().describe("Only used when format is 'thermal'. Defaults to 57mm."),
  thermalHeightMm: z.number().positive().optional().describe("Only used when format is 'thermal'. Defaults to 32mm."),
});

/** Shared by download_labels/print_labels — only `dryRun` differs, and each tool sets that itself. */
export const printRequestShape = {
  requests: z.array(LabelRequestSchema).min(1).describe('The SKUs and quantities to label.'),
  combine: z
    .boolean()
    .optional()
    .describe('Pack all SKUs onto shared sheets (pre-Phase-5 behavior). Default is one sheet-aligned PDF per SKU.'),
  format: LabelFormatSchema.optional().describe('Overrides the default format for every request that doesn’t set its own.'),
};

/** Shared by download_shipment_labels/print_shipment_labels. */
export const shipmentRequestShape = {
  shipment: z.string().min(1).describe('Send to Amazon workflow id (wf...), or its confirm_content_step URL.'),
  combine: z
    .boolean()
    .optional()
    .describe('Pack all SKUs onto shared sheets (pre-Phase-5 behavior). Default is one sheet-aligned PDF per SKU.'),
  format: LabelFormatSchema.optional().describe('Overrides the default format for every SKU in the shipment.'),
};
