/*
 * Tiny console logger — no dependency, readable output when run from a skill.
 *
 * Every level writes to stderr (console.error), not stdout. `--json` output
 * (cli.ts) writes JSON.stringify(...) straight to stdout via console.log,
 * bypassing this module entirely — so stdout carries only that JSON, and a
 * caller doing `npm run print -- ... --json | jq ...` gets parseable output
 * regardless of how much progress/diagnostic text a run logs in between.
 */

const stamp = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (msg: string, ...rest: unknown[]) => console.error(`[${stamp()}] ${msg}`, ...rest),
  step: (msg: string, ...rest: unknown[]) => console.error(`[${stamp()}] → ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.error(`[${stamp()}] ! ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`[${stamp()}] ✗ ${msg}`, ...rest),
  done: (msg: string, ...rest: unknown[]) => console.error(`[${stamp()}] ✓ ${msg}`, ...rest),
};
