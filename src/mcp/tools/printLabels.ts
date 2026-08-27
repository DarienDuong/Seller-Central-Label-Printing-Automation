import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLabelTool } from './labelTool.js';

export function registerPrintLabels(server: McpServer): void {
  registerLabelTool(server, {
    name: 'print_labels',
    dryRun: false,
    title: 'Print product labels',
    description:
      'Generate label PDFs for the given SKUs and send them to the configured printer (PRINTER_NAME). ' +
      'This spools physical paper — use download_labels first to preview if unsure.',
  });
}
