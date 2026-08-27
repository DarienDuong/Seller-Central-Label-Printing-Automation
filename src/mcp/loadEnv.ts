/**
 * Must be the first import in server.ts. config.ts's own `import
 * 'dotenv/config'` reads .env relative to process.cwd(), which the CLI can
 * rely on (npm always runs it from the project root) but an MCP host can't
 * be assumed to — it spawns the server binary from wherever its own config
 * points. Loading with an explicit path here, before config.ts ever
 * executes, wins: dotenv doesn't overwrite already-set env vars, so
 * config.ts's later `import 'dotenv/config'` becomes a no-op once this has
 * already run.
 */
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv({ path: resolve(import.meta.dirname, '../../.env') });
