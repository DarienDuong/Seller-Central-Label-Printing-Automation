/* Tiny console logger — no dependency, readable output when run from a skill. */

const stamp = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`[${stamp()}] ${msg}`, ...rest),
  step: (msg: string, ...rest: unknown[]) => console.log(`[${stamp()}] → ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`[${stamp()}] ! ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`[${stamp()}] ✗ ${msg}`, ...rest),
  done: (msg: string, ...rest: unknown[]) => console.log(`[${stamp()}] ✓ ${msg}`, ...rest),
};
