# Seller Central Label Printing Automation

Playwright automation that generates and prints product (FNSKU/item) labels from
Amazon Seller Central. This is the **boilerplate**: the structure, session
handling, CLI, and print flow are in place; the Seller Central selectors are
first-guess placeholders that need one pass against the live account.

Designed to be wrapped as a Claude Code plugin skill later — the CLI takes
structured input (`--file products.json`) and can emit structured output
(`--json`).

## Requirements

- Node **18+** (this machine's default `node` is 16 — use `nvm use 22`, an
  `.nvmrc` is included)
- A Seller Central account with FBA/label permissions
- Optional: a CUPS printer for auto-printing (`lpstat -p`)

## Setup

```bash
nvm use && npm install && cp .env.example .env
```

Fill in `.env` — at minimum `SC_MERCHANT_ID` and `SC_MARKETPLACE_ID`, which you
can copy out of any Seller Central URL after switching to the right account.

## Sign in once

```bash
npm run login
```

A real Chromium window opens. **You** sign in — the script never types
credentials and never handles OTP codes. Once it detects a live session it saves
cookies + localStorage to `.auth/seller-central.json` and closes. Every later run
replays that file. Re-run this when a run reports "session expired".

`.auth/` is gitignored. Treat it like a password: anyone with that file has your
Seller Central session.

## Print labels

```bash
npm run print -- --sku ABC-123 --qty 30 --dry-run
```

```bash
npm run print -- --file data/products.json
```

`--dry-run` downloads the PDF to `output/` and stops there — use it until the
selectors are verified. Without a `PRINTER_NAME` in `.env`, every run behaves
like a dry run anyway.

Other flags: `--format 30-up`, `--headed`, `--json`, `--printers`, `--help`.

## Inspect inventory

```bash
npm run list -- --search "coffee"
```

## Layout

| Path | Role |
| --- | --- |
| [src/cli.ts](src/cli.ts) | Arg parsing and the `login` / `print` / `list` commands |
| [src/config.ts](src/config.ts) | `.env` loading, Seller Central URL builder |
| [src/browser.ts](src/browser.ts) | Chromium launch + saved-session context |
| [src/auth.ts](src/auth.ts) | Interactive login, session detection |
| [src/pages/inventoryPage.ts](src/pages/inventoryPage.ts) | Manage Inventory + Print Item Labels page object |
| [src/tasks/printLabels.ts](src/tasks/printLabels.ts) | Batch flow: search → label → save → print |
| [src/printer.ts](src/printer.ts) | CUPS `lp` handoff |

## Next step: verify the selectors

Every locator in [src/pages/inventoryPage.ts](src/pages/inventoryPage.ts) is
marked `TODO(selectors)`. Seller Central's DOM varies by account, marketplace,
and A/B bucket, so these have to be confirmed against the real UI rather than
guessed. The fastest path:

```bash
BROWSER_MODE=headed SLOW_MO=400 npm run print -- --sku YOUR-SKU --qty 1 --dry-run
```

Watch where it stalls, grab the real locator with Playwright's inspector
(`PWDEBUG=1`), and replace the placeholder. Prefer role + visible text over
generated class names — Amazon rotates those.

Also confirm `FORMAT_LABELS` matches the exact option strings in the live
label-format dropdown.

## Notes

- One browser session is reused for a whole batch; a failing SKU is recorded and
  the run continues.
- Automating Seller Central is subject to Amazon's terms — keep the pace human,
  don't run it as a scraper, and expect occasional bot checks that need a headed
  window.
