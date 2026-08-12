import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from './config.js';
import { log } from './logger.js';

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Persist cookies/localStorage back to disk, then close everything. */
  close(opts?: { save?: boolean }): Promise<void>;
}

interface LaunchOptions {
  /** Force a headed window regardless of BROWSER_MODE (login needs this). */
  headed?: boolean;
  /** Start from a blank context instead of the saved session. */
  fresh?: boolean;
}

/**
 * Launch Chromium and return a context seeded with the saved Seller Central
 * session, if one exists. Amazon fingerprints heavily, so we keep the profile
 * boring and stable rather than randomizing it.
 */
export async function launchSession(opts: LaunchOptions = {}): Promise<Session> {
  const useState = !opts.fresh && existsSync(config.storageStatePath);
  if (!useState && !opts.fresh) {
    log.warn(`No saved session at ${config.storageStatePath} — run \`npm run login\` first.`);
  }

  const browser = await chromium.launch({
    headless: opts.headed ? false : config.headless,
    slowMo: config.slowMo,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState: useState ? config.storageStatePath : undefined,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    acceptDownloads: true,
  });
  context.setDefaultTimeout(config.timeoutMs);
  context.setDefaultNavigationTimeout(config.timeoutMs);

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    async close({ save = false } = {}) {
      if (save) await saveStorageState(context);
      await context.close();
      await browser.close();
    },
  };
}

export async function saveStorageState(context: BrowserContext): Promise<void> {
  await mkdir(dirname(config.storageStatePath), { recursive: true });
  await context.storageState({ path: config.storageStatePath });
  log.done(`Session saved to ${config.storageStatePath}`);
}
