import 'dotenv/config';
import { resolve } from 'node:path';
import type { LabelFormat } from './types.js';

const ROOT = resolve(import.meta.dirname, '..');

function str(key: string, fallback = ''): string {
  return (process.env[key] ?? fallback).trim();
}

function int(key: string, fallback: number): number {
  const raw = str(key);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  root: ROOT,
  baseUrl: str('SC_BASE_URL', 'https://sellercentral.amazon.com').replace(/\/$/, ''),
  /** Display text of the marketplace row in Amazon's account-switcher interstitial. */
  marketplaceName: str('SC_MARKETPLACE_NAME', 'United States'),
  storageStatePath: resolve(ROOT, str('SC_STORAGE_STATE', '.auth/seller-central.json')),
  outputDir: resolve(ROOT, str('OUTPUT_DIR', 'output')),
  headless: str('BROWSER_MODE', 'headed') === 'headless',
  slowMo: int('SLOW_MO', 0),
  defaultFormat: (str('DEFAULT_LABEL_FORMAT', 'ItemLabel_Letter_30') || 'ItemLabel_Letter_30') as LabelFormat,
  printerName: str('PRINTER_NAME'),
  /** Every navigation/wait in the flow uses this unless it needs longer. */
  timeoutMs: int('TIMEOUT_MS', 45_000),
} as const;

/**
 * Build a Seller Central URL. Deliberately does NOT append the classic
 * mons_sel_dir_mcid/mons_sel_mkid account-context params — verified
 * 2026-08-12 that "New Seller Central" rejects them on some pages with
 * "Invalid request URL from client" once a session has an active
 * marketplace selection. Account context is established once, via the
 * account-switcher click-through in auth.ts (login() and gotoAuthed()'s
 * resolveAccountSwitcher()), and then persists in the session cookie.
 */
export function scUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, config.baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}
