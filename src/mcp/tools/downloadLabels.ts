import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLabelTool } from './labelTool.js';

export function registerDownloadLabels(server: McpServer): void {
  registerLabelTool(server, {
    name: 'download_labels',
    dryRun: true,
    title: 'Download product labels',
    description: 'Generate label PDFs for the given SKUs and save them to output/. Never touches a printer.',
  });
}
