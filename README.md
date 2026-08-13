# Seller Central Label Printing Automation

Playwright automation that generates and prints product (FNSKU/item) labels from
Amazon Seller Central. The flow is verified end-to-end against a live account —
see [How it works](#how-it-works) for what that covers.

Designed to be wrapped as a Claude Code plugin skill later — the CLI takes
structured input (`--file products.json`) and can emit structured output
(`--json`).

## Requirements

- Node **22** (an `.nvmrc` is included — run `nvm use`)
- A Seller Central account with FBA/label permissions
- Optional: a CUPS printer for auto-printing (`lpstat -p`)

## Setup

```bash
nvm use && npm install && cp .env.example .env
```

`npm install` also downloads a Chromium browser for Playwright (via
`postinstall`) — the first install may take a minute.

The defaults in `.env.example` work as-is for a single US account. The only
value worth checking is `SC_MARKETPLACE_NAME` — it must exactly match the
marketplace name shown in Amazon's account-switcher screen (see below), which
is `United States` by default.

## Sign in once

```bash
npm run login
```

A real Chromium window opens. **You** sign in — the script never sees or types
your password, and never handles OTP / 2-step verification. Once it detects a
live session, it also clicks through Amazon's "Select an account"
interstitial if one appears (using `SC_MARKETPLACE_NAME`), then saves the
session to `.auth/seller-central.json` and closes. Every later run replays
that file — you shouldn't need a browser window again until the session
expires.

Re-run this whenever a run reports "Not signed in (or session expired)."

`.auth/` is gitignored. Treat it like a password: anyone with that file has your
Seller Central session.

## Print labels

```bash
npm run print -- --sku ABC-123 --qty 30 --dry-run
```

```bash
npm run print -- --file data/products.json
```

`--dry-run` downloads the PDF to `output/` without sending it to a printer —
good for a first run on unfamiliar SKUs. Without a `PRINTER_NAME` in `.env`,
every run behaves like a dry run regardless.

SKUs passed in the same run that share a label format are combined into a
single PDF — this mirrors how Seller Central's own Print Item Labels page
batches SKUs, so printing a whole shipment's worth of labels is one PDF, not
one per SKU.

Flags:

| Flag | Meaning |
| --- | --- |
| `--sku <sku>` / `--qty <n>` | Repeatable pair — quantity applies to the `--sku` right before it |
| `--file <path>` | JSON array of `{ sku, quantity, format?, title? }` — see [data/products.example.json](data/products.example.json) |
| `--format <fmt>` | `ItemLabel_Letter_30` (default), `ItemLabel_A4_27`, `ItemLabel_A4_24`, `ItemLabel_A4_21`, `ItemLabel_A4_40_52x29`, `ItemLabel_A4_44_48x25`, or `thermal` |
| `--dry-run` | Download only, never send to the printer |
| `--headed` | Force a visible browser window |
| `--json` | Machine-readable output (for skill use) |
| `--printers` | List CUPS printers and exit |
| `--help` | Show usage |

## Where the PDFs go

Downloaded labels land in `output/` (`OUTPUT_DIR` in `.env`), one file per
format group per run: `labels_<SKUs>_<timestamp>.pdf`. `output/` is
gitignored.

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
| [src/tasks/printLabels.ts](src/tasks/printLabels.ts) | Batch flow: group by format → print-labels page → set quantities → submit → save |
| [src/printer.ts](src/printer.ts) | CUPS `lp` handoff |

## How it works

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
