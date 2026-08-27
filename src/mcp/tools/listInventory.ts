import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { launchSession } from '../../browser.js';
import { InventoryPage } from '../../pages/inventoryPage.js';
import { withSessionLock } from '../sessionLock.js';
import { jsonResult, errorResult } from '../toolResult.js';

export function registerListInventory(server: McpServer): void {
  server.registerTool(
    'list_inventory',
    {
      title: 'Search Seller Central inventory',
      description: 'Search Manage Inventory by SKU, title/keyword, FNSKU, ASIN, or UPC/EAN. Read-only.',
      inputSchema: {
        search: z.string().optional().describe('Search text. Omit to list the default (unfiltered) grid view.'),
      },
    },
    async ({ search }) => {
      try {
        const items = await withSessionLock(async () => {
          const session = await launchSession({});
          try {
            const inventory = new InventoryPage(session.page);
            await inventory.open();
            if (search) await inventory.search(search);
            return await inventory.listVisible();
          } finally {
            await session.close({ save: true });
          }
        });
        return jsonResult(items);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
