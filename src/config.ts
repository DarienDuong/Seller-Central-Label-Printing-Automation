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
  merchantId: str('SC_MERCHANT_ID'),
  marketplaceId: str('SC_MARKETPLACE_ID', 'ATVPDKIKX0DER'),
  storageStatePath: resolve(ROOT, str('SC_STORAGE_STATE', '.auth/seller-central.json')),
  outputDir: resolve(ROOT, str('OUTPUT_DIR', 'output')),
  headless: str('BROWSER_MODE', 'headed') === 'headless',
  slowMo: int('SLOW_MO', 0),
  defaultFormat: (str('DEFAULT_LABEL_FORMAT', '30-up') || '30-up') as LabelFormat,
  printerName: str('PRINTER_NAME'),
  /** Every navigation/wait in the flow uses this unless it needs longer. */
  timeoutMs: int('TIMEOUT_MS', 45_000),
} as const;

/** Seller Central appends account context to most URLs; centralize that here. */
export function scUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, config.baseUrl);
  if (config.merchantId) url.searchParams.set('mons_sel_dir_mcid', config.merchantId);
  if (config.marketplaceId) url.searchParams.set('mons_sel_mkid', config.marketplaceId);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}
