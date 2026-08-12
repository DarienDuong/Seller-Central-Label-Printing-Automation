import { config, scUrl } from './config.js';
import { launchSession, saveStorageState } from './browser.js';
import { log } from './logger.js';
import type { Page } from 'playwright';

/**
 * Interactive, one-time login.
 *
 * By design this script never types your Amazon credentials. It opens a real
 * browser window, you sign in yourself (including OTP / 2SV), and once the
 * session is live it snapshots cookies + localStorage to disk. Every later run
 * replays that snapshot, so it should be the only time you touch a keyboard.
 *
 * Amazon expires these sessions periodically — when a run reports "not signed
 * in", just run `npm run login` again.
 */
export async function login(): Promise<void> {
  const session = await launchSession({ headed: true, fresh: true });
  const { page } = session;

  log.info('Opening Seller Central sign-in…');
  // Deliberately bypass scUrl() here: appending mons_sel_dir_mcid/mons_sel_mkid
  // before a session exists makes Amazon's sign-in redirect reject the URL
  // ("Invalid request URL from client"). Account/marketplace is picked
  // manually in the UI after signing in.
  await page.goto(`${config.baseUrl}/home`, { waitUntil: 'domcontentloaded' });

  log.info('');
  log.info('  Sign in manually in the browser window that just opened.');
  log.info('  Complete any OTP / two-step verification and pick the right');
  log.info('  merchant account + marketplace. This script will wait.');
  log.info('');

  const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
  const deadline = Date.now() + SIGN_IN_WINDOW_MS;

  while (Date.now() < deadline) {
    if (await isSignedIn(page)) {
      log.done('Signed-in session detected.');

      // Deep-linked feature pages (e.g. /fba/printitemlabel/) redirect to
      // Amazon's account-switcher interstitial on a session with no active
      // marketplace selection — /home alone doesn't trigger it. Force that
      // resolution now, once, so it's captured in the saved storage state
      // and every later automated run skips straight past it.
      await page.goto(`${config.baseUrl}/fba/printitemlabel/`, { waitUntil: 'domcontentloaded' });
      await resolveAccountSwitcher(page);

      await saveStorageState(session.context);
      await session.close();
      return;
    }
    await page.waitForTimeout(2_000);
  }

  await session.close();
  throw new Error('Timed out waiting for sign-in (10 minutes).');
}

/**
 * Handle Amazon's "Select an account" interstitial (/account-switcher/...).
 * Verified 2026-08-12: it doesn't accept mons_sel_dir_mcid/mons_sel_mkid query
 * params the way classic Seller Central URLs do — a session with no active
 * marketplace selection gets redirected here on deep links instead. Picking
 * a marketplace and confirming sets a session cookie, so this only needs to
 * fire once per saved session.
 */
async function resolveAccountSwitcher(page: Page): Promise<void> {
  if (!page.url().includes('/account-switcher/')) return;
  log.info(`Account switcher interstitial — selecting "${config.marketplaceName}"…`);
  await page.getByRole('button', { name: config.marketplaceName, exact: true }).click();
  await page.getByRole('button', { name: 'Select account', exact: true }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/**
 * Heuristic session check. Amazon redirects unauthenticated requests to
 * /ap/signin, so a landed Seller Central URL plus the account nav is a good
 * enough signal without hitting an API.
 *
 * Verified 2026-08-12: #sc-search-field (the top-nav search box) is present
 * on every Seller Central page once signed in. It's client-rendered — the
 * page shows a loading spinner right after domcontentloaded — so this waits
 * for it rather than checking instantly.
 */
export async function isSignedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes('/ap/signin') || url.includes('/ap/mfa')) return false;
  if (!url.startsWith(config.baseUrl)) return false;

  const marker = page.locator('#sc-search-field, #sc-content-container, #partner-navigation, [data-testid="sc-nav-root"]');
  return marker
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
}

/** Navigate somewhere in Seller Central, failing loudly if the session died. */
export async function gotoAuthed(page: Page, path: string, params?: Record<string, string>): Promise<void> {
  await page.goto(scUrl(path, params), { waitUntil: 'domcontentloaded' });
  await resolveAccountSwitcher(page);
  if (!(await isSignedIn(page))) {
    throw new Error('Not signed in (or session expired). Run `npm run login` and retry.');
  }
}
