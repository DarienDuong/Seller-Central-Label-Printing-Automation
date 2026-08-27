import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listPrinters } from '../../printer.js';
import { jsonResult, errorResult } from '../toolResult.js';

export function registerListPrinters(server: McpServer): void {
  server.registerTool(
    'list_printers',
    {
      title: 'List available printers',
      description: 'List printers this machine can send labels to (CUPS on macOS/Linux, Win32_Printer on Windows).',
    },
    async () => {
      try {
        return jsonResult(await listPrinters());
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
