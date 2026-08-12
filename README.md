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

The defaults in `.env.example` work as-is for a single US account. If your
account's marketplace shows under a different name in Amazon's account-switcher
screen (multiple marketplaces, non-US, etc.), set `SC_MARKETPLACE_NAME` to
match it exactly.

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

Other flags: `--format ItemLabel_Letter_30` (or `thermal`), `--headed`, `--json`, `--printers`, `--help`.

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

## Selector status

Verified 2026-08-12 against a live account. The print flow bypasses the
Manage Inventory grid entirely — Seller Central exposes a dedicated page,
`/fba/printitemlabel/?mSku.0=<sku>&mSku.1=<sku>...`, that accepts a batch of
SKUs directly in the URL query string and renders one row per SKU with its
own quantity field. `printLabels` groups requests by format and does one
page load + one Print click per group, producing one PDF per group.

A few things worth knowing if selectors ever need re-verifying (Seller
Central's DOM varies by account/A-B bucket):
- The grid and the print-labels page are both built from shadow-DOM Katal
  (`kat-*`) web components — Playwright's default CSS/text locators pierce
  open shadow roots automatically, no special handling needed.
- Unknown/invalid SKUs are silently dropped from the print-labels page (no
  error) — `renderedSkus()` diffs requested vs. rendered SKUs to detect them.
- "Standard formats" offers a fixed Paper/Sticker Type dropdown (30/27/24/21/40/44-up).
  "Thermal printing" replaces that dropdown with freeform Width (mm) / Height (mm)
  fields (Amazon's own default is 57 × 32mm) — there's no fixed thermal preset.
- `Manage Inventory`'s `list` command scraping (`listVisible`) only has the
  SKU column confirmed; title/available columns are still a guess.

To re-verify after a UI change:

```bash
BROWSER_MODE=headed SLOW_MO=400 npm run print -- --sku YOUR-SKU --qty 1 --dry-run
```

## Notes

- One browser session is reused for a whole batch; a failing SKU is recorded and
  the run continues.
- Automating Seller Central is subject to Amazon's terms — keep the pace human,
  don't run it as a scraper, and expect occasional bot checks that need a headed
  window.
