/**
 * Every tool that calls launchSession() reads and writes the same
 * .auth/seller-central.json on close. Two concurrent tool calls would race
 * that write (and drive two Chromium instances against one saved session at
 * once), so every session-holding tool handler must go through this queue
 * instead of launching a session directly. Matches the CLI's own
 * one-command-at-a-time model, just enforced explicitly here since the MCP
 * server is a single long-lived process fielding calls from a model that can
 * (in principle) request several at once.
 */
let tail: Promise<unknown> = Promise.resolve();

export function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn, fn);
  // Swallow rejections in the chain itself so one failed call doesn't wedge
  // every call queued behind it — callers still see their own rejection via
  // the returned promise.
  tail = result.catch(() => undefined);
  return result;
}
