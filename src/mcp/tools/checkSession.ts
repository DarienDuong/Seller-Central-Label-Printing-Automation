import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../../config.js';
import { launchSession } from '../../browser.js';
import { isSignedIn } from '../../auth.js';
import { withSessionLock } from '../sessionLock.js';
import { jsonResult, errorResult } from '../toolResult.js';

export function registerCheckSession(server: McpServer): void {
  server.registerTool(
    'check_session',
    {
      title: 'Check Seller Central session',
      description:
        'Reports whether the saved Seller Central session (.auth/seller-central.json) is still valid. ' +
        'If not signed in, tell the user to run `npm run login` themselves — this tool never signs in.',
    },
    async () => {
      try {
        const result = await withSessionLock(async () => {
          const session = await launchSession({});
          try {
            await session.page.goto(`${config.baseUrl}/home`, { waitUntil: 'domcontentloaded' });
            return await isSignedIn(session.page);
          } finally {
            // Nothing to persist — this is a read-only check.
            await session.close();
          }
        });
        return jsonResult({
          signedIn: result,
          message: result ? undefined : 'Not signed in. Run `npm run login` and try again.',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
