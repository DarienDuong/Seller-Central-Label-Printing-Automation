import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Every tool here returns JSON as its one text block — never prose to parse. */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * MCP tool errors are reported via isError, not a thrown exception — a
 * thrown exception is a protocol-level failure, not "the SKU wasn't found."
 * Every handler in this directory catches its own errors and goes through
 * this instead of letting them escape.
 */
export function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}
