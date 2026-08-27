import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerShipmentLabelTool } from './shipmentLabelTool.js';

export function registerDownloadShipmentLabels(server: McpServer): void {
  registerShipmentLabelTool(server, {
    name: 'download_shipment_labels',
    dryRun: true,
    title: 'Download a shipment’s labels',
    description:
      'Read a Send to Amazon shipment’s ready-to-send SKUs and generate one label PDF per unit, saved to output/. ' +
      'Never touches a printer. This page is slow to load (15-20s to first paint).',
  });
}
