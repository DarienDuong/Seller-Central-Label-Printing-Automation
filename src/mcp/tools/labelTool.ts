import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { printLabels, type PrintOptions } from '../../tasks/printLabels.js';
import type { LabelRequest } from '../../types.js';
import { printRequestShape } from '../schemas.js';
import { withSessionLock } from '../sessionLock.js';
import { jsonResult, errorResult } from '../toolResult.js';

/**
 * download_labels and print_labels are the same underlying printLabels()
 * call with `dryRun` fixed by which tool was invoked — the model chooses the
 * physical side effect by which tool it calls, not by a boolean it could get
 * wrong. This factory is what keeps that one call site.
 */
export function registerLabelTool(server: McpServer, opts: { name: string; dryRun: boolean; title: string; description: string }): void {
  server.registerTool(
    opts.name,
    {
      title: opts.title,
      description: opts.description,
      inputSchema: printRequestShape,
    },
    async ({ requests, combine, format }) => {
      try {
        const withFormat: LabelRequest[] = requests.map((r) => ({ ...r, format: r.format ?? format }));
        const options: PrintOptions = { dryRun: opts.dryRun, combine };
        const results = await withSessionLock(() => printLabels(withFormat, options));
        return jsonResult(results);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
