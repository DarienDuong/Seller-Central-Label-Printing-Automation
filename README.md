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
- Optional: a printer for auto-printing — CUPS on macOS/Linux (`lpstat -p`),
  any installed printer on Windows (see [Printing on Windows](#printing-on-windows))

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

One SKU:

```bash
npm run print -- --sku ABC-123 --qty 30 --dry-run
```

`--dry-run` downloads the PDF to `output/` without sending it to a printer —
good for a first run on unfamiliar SKUs. Without a `PRINTER_NAME` in `.env`,
every run behaves like a dry run regardless.

### Multiple SKUs

SKUs passed in the same run that share a label format are combined into a
single PDF — this mirrors how Seller Central's own Print Item Labels page
batches SKUs, so printing a whole shipment's worth of labels is one PDF, not
one per SKU. Multiple SKUs with *different* formats still print in one run;
each format just gets its own PDF.

Repeat `--sku`/`--qty` for a handful of SKUs on the command line — each `--qty`
applies to the `--sku` immediately before it:

```bash
npm run print -- --sku ABC-123 --qty 30 --sku XYZ-789 --qty 6 --dry-run
```

For a whole shipment, put them in a JSON file instead — copy the example and
edit it:

```bash
cp data/products.example.json data/products.json
```

```json
[
  { "sku": "ABC-123", "quantity": 30 },
  { "sku": "XYZ-789", "quantity": 6 },
  { "sku": "DEF-456", "quantity": 12, "format": "thermal" }
]
```

`format` and `title` are optional per SKU — `title` is just for the log
output, and `format` overrides `DEFAULT_LABEL_FORMAT` for that one SKU (the
`thermal` one above prints as its own separate PDF from the other two).

```bash
npm run print -- --file data/products.json --dry-run
```

### A whole shipment

Instead of listing SKUs yourself, point it at a Send to Amazon workflow and it
reads the shipment's contents and prints one label per unit:

```bash
npm run print -- --shipment wf7f067182-69c7-4aa8-bb32-5c3cdee02ba5 --dry-run
```

You can paste the whole browser URL instead of the bare id — both work:

```bash
npm run print -- --shipment "https://sellercentral.amazon.com/fba/sendtoamazon/confirm_content_step?wf=wf7f0..." --dry-run
```

Note this is the **workflow** id (`wf…`) from the Send to Amazon URL, not the
`FBA…` shipment id — an in-progress shipment doesn't have an `FBA…` id yet.
Passing an `FBA…` id gives you an error that says so.

To see what's in a shipment without printing anything:

```bash
npm run shipment -- --shipment wf7f067182-69c7-4aa8-bb32-5c3cdee02ba5
```

```
1A-36WM-NXLR                198 units  (33 boxes)
96-7AZY-29SC                396 units  (66 boxes)
...
12 SKUs, 2433 units total.
```

Worth doing first — a real shipment can be thousands of labels (the example
above is 82 pages of 30-up), so it's cheap insurance against printing the
wrong workflow.

Reading a shipment and printing its labels share one browser session and one
sign-in, so `--shipment` takes roughly a minute end to end (a shipment can be
30–60+ SKUs, and the Send to Amazon page itself is slow — see
[How it works](#shipment-mode)) — that's normal, not a hang. `BROWSER_MODE=headed`
(the `.env.example` default) pops a real Chromium window for that whole
minute; switch to `BROWSER_MODE=headless` in `.env` once you trust the flow
and don't need to watch it.

Flags:

| Flag | Meaning |
| --- | --- |
| `--sku <sku>` / `--qty <n>` | Repeatable pair — quantity applies to the `--sku` right before it |
| `--file <path>` | JSON array of `{ sku, quantity, format?, title? }` — see [data/products.example.json](data/products.example.json) |
| `--shipment <wf>` | Send to Amazon workflow id (or its URL) — labels every ready-to-send SKU, one label per unit |
| `--format <fmt>` | `ItemLabel_Letter_30` (default), `ItemLabel_A4_27`, `ItemLabel_A4_24`, `ItemLabel_A4_21`, `ItemLabel_A4_40_52x29`, `ItemLabel_A4_44_48x25`, or `thermal` |
| `--dry-run` | Download only, never send to the printer |
| `--headed` | Force a visible browser window |
| `--json` | Machine-readable output (for skill use) |
| `--printers` | List known printers and exit |
| `--help` | Show usage |

## Printing on Windows

The warehouse printer is on a Windows PC, so `src/printer.ts` branches by
platform — same `PRINTER_NAME` in `.env`, same CLI, no code changes needed
either side. But the mechanism is very different, because Windows has no
CLI equivalent of `lp -d <printer>`:

- There's no built-in way to send a PDF to a *named* printer from the
  command line. The only printer-agnostic route is the registered PDF
  handler's "Print" shell verb (`Start-Process -Verb Print`), and that verb
  always prints to the current **default** printer — it doesn't take a
  printer name.
- So each print job: reads the current Windows default printer, flips the
  default to `PRINTER_NAME` (via `Win32_Printer.SetDefaultPrinter` over
  PowerShell/CIM), fires the Print verb once per copy, waits ~5s per copy
  for the handler to pick the job up, then restores the original default.
- This needs a PDF viewer with a registered Print verb — Edge (installed on
  every Windows box) or Acrobat both work.
- `--printers` on Windows lists `Win32_Printer` names instead of CUPS
  queues.

This flips the machine's default printer for the duration of the print
call. It's restored automatically afterward, but if the process is killed
mid-print the default may be left pointing at `PRINTER_NAME` until the next
run (or you fix it by hand in Settings). It hasn't yet been verified against
a real Windows box + physical printer — the code paths were written and
typechecked but not run live; treat the first real run as the actual test
and watch it happen (`--dry-run` first, or watch the print job appear in
the print queue).

### Setting `PRINTER_NAME` on Windows

`PRINTER_NAME` has to match a name Windows itself knows about — the same
string shown in **Settings → Bluetooth & devices → Printers & scanners**, or
from PowerShell:

```powershell
Get-CimInstance -ClassName Win32_Printer | Select-Object Name
```

or equivalently, once the repo is set up:

```bash
npm run print -- --printers
```

Example output:

```
Name
----
Zebra ZD420 (Warehouse)
Microsoft Print to PDF
HP LaserJet M110
```

Copy the exact printer name (including spaces/parens) into `.env`:

```bash
PRINTER_NAME=Zebra ZD420 (Warehouse)
```

Then verify it end to end — `--dry-run` first to confirm the PDF itself
looks right, then a real run for one SKU/qty 1 to confirm the job actually
reaches that printer:

```bash
npm run print -- --sku ABC-123 --qty 1 --dry-run
npm run print -- --sku ABC-123 --qty 1
```

If `PRINTER_NAME` doesn't exactly match a `Win32_Printer` name, `SetDefaultPrinter`
fails and the run errors out before anything prints — it will not silently
fall back to whatever printer happened to be default.

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
| [src/cli.ts](src/cli.ts) | Arg parsing and the `login` / `print` / `shipment` / `list` commands |
| [src/config.ts](src/config.ts) | `.env` loading, Seller Central URL builder |
| [src/browser.ts](src/browser.ts) | Chromium launch + saved-session context |
| [src/auth.ts](src/auth.ts) | Interactive login, session detection |
| [src/pages/inventoryPage.ts](src/pages/inventoryPage.ts) | Manage Inventory + Print Item Labels page object |
| [src/pages/shipmentPage.ts](src/pages/shipmentPage.ts) | Send to Amazon content step — reads a shipment's SKUs and unit counts |
| [src/tasks/printLabels.ts](src/tasks/printLabels.ts) | Batch flow: group by format → print-labels page → set quantities → submit → save |
| [src/tasks/shipmentLabels.ts](src/tasks/shipmentLabels.ts) | Turns a shipment workflow into label requests |
| [src/printer.ts](src/printer.ts) | Printer handoff — CUPS `lp` on macOS/Linux, PowerShell/Win32_Printer on Windows |

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
- Both formats have been checked against the actual generated PDF, not just
  "no error thrown": Standard produces the requested label count laid out on
  the chosen paper size with a real FNSKU barcode; Thermal produces one
  label per page sized exactly to the requested Width/Height (mm). Runs
  headless the same as headed.
- "Standard formats" offers a fixed Paper/Sticker Type dropdown (30/27/24/21/40/44-up).
  "Thermal printing" replaces that dropdown with freeform Width (mm) / Height (mm)
  fields (Amazon's own default is 57 × 32mm) — there's no fixed thermal preset.
- `Manage Inventory` rows have no fixed column layout in their text — "Out of
  stock" rows carry an extra "Replenish inventory" action line that shifts
  everything after it. `listVisible()` locates SKU/ASIN/title/available by
  the label line right before/after them (e.g. the line after "SKU"), not by
  position, so it holds up across listing statuses.

### Shipment mode

Verified 2026-08-13 against a live open shipment. Shipment mode is purely a
*read* of the Send to Amazon content step — it scrapes SKUs and unit counts,
then hands them to the same verified print flow above. It never confirms,
modifies, or advances a workflow.

- The step is keyed by **workflow** id (`wf…`), not the `FBA…` shipment id; an
  in-progress workflow has no `FBA…` id yet.
- The page has two tabs. The default, "All FBA SKUs", lists your entire
  catalogue with empty quantity fields — reading it would be badly wrong.
  Shipment contents live on the **"SKUs ready to send (N)"** tab, where
  quantities are rendered as *text* ("Units: 198"), not form inputs.
- Pagination on this tab is a trap. The pager's `total-items` is the number
  of rows *currently rendered*, not the shipment total — at 10 rows/page a
  12-SKU shipment reports `total-items=10` — and because it reports
  total == page size, the widget concludes there's one page and renders **no
  next/prev controls at all**. So `total-items` can't be used as a
  completeness check, and there's nothing to click through to page 2.
  The trustworthy total is the tab's own label, "SKUs ready to send (N)".
  The code reads N from there, requests the largest page size Amazon offers
  (100) so everything lands on one page, and requires exactly N rows before
  returning. A shipment over 100 ready-to-send SKUs fails loudly with
  instructions rather than silently printing a subset.
- This page is genuinely slow — 15–20s to first paint is normal, and the
  newer React Shipments list (`/amazonsell/shipments`) frequently hangs
  outright. Waits here are deliberately long.
- `printShipmentLabels()` reads the shipment and prints in **one** browser
  session — an earlier version launched a separate session for each half,
  which roughly doubled runtime and doubled the odds of the browser closing
  mid-run. If you see a "Target page, context or browser has been closed"
  error, confirm you're not on that earlier version (`shipmentToRequests`
  in a stack trace is the tell).
- Page size must be set **before** switching tabs: changing it re-queries the
  list and resets it to the default "All FBA SKUs" tab, silently discarding
  the switch (seen live as "Read 1 of 1429 SKUs").
- Locators here are scoped to a container (`kat-dropdown[data-testid=
  "page-size-dropdown"]`, `kat-tab`). An unscoped `kat-option` locator picks
  from ~76 options across the page's other dropdowns and blocks until the
  action timeout — which is how page size silently never applied at all.
- `SHIPMENT_PAGE_SIZE` overrides the requested page size (10/25/50/100). It
  exists so the "shipment doesn't fit on one page" path can be exercised
  against a normal-sized shipment; leave it unset in normal use.

To re-verify after a UI change:

```bash
BROWSER_MODE=headed SLOW_MO=400 npm run print -- --sku YOUR-SKU --qty 1 --dry-run
```

## Notes

- One browser session is reused for a whole batch — including `--shipment`,
  where reading the shipment and printing its labels share the same session;
  a failing SKU is recorded and the run continues.
- Automating Seller Central is subject to Amazon's terms — keep the pace human,
  don't run it as a scraper, and expect occasional bot checks that need a headed
  window.
