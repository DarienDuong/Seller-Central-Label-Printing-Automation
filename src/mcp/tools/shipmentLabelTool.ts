import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { printShipmentLabels } from '../../tasks/shipmentLabels.js';
import { shipmentRequestShape } from '../schemas.js';
import { withSessionLock } from '../sessionLock.js';
import { jsonResult, errorResult } from '../toolResult.js';

/** Same download/print split as labelTool.ts, for whole-shipment requests. */
export function registerShipmentLabelTool(
  server: McpServer,
  opts: { name: string; dryRun: boolean; title: string; description: string },
): void {
  server.registerTool(
    opts.name,
    {
      title: opts.title,
      description: opts.description,
      inputSchema: shipmentRequestShape,
    },
    async ({ shipment, combine, format }) => {
      try {
        const results = await withSessionLock(() =>
          printShipmentLabels(shipment, { dryRun: opts.dryRun, combine, ...(format ? { format } : {}) }),
        );
        return jsonResult(results);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
