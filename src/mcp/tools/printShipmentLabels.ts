import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerShipmentLabelTool } from './shipmentLabelTool.js';

export function registerPrintShipmentLabels(server: McpServer): void {
  registerShipmentLabelTool(server, {
    name: 'print_shipment_labels',
    dryRun: false,
    title: 'Print a shipment’s labels',
    description:
      'Read a Send to Amazon shipment’s ready-to-send SKUs, generate one label PDF per unit, and send it to the ' +
      'configured printer (PRINTER_NAME). This spools physical paper for the whole shipment — use ' +
      'download_shipment_labels first to preview if unsure. Read-only against the shipment itself; never confirms ' +
      'or advances the workflow.',
  });
}
