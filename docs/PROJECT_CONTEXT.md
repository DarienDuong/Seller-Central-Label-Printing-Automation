# Project context & status

Handoff doc for starting a fresh Claude Code / Codex session on this repo without
re-deriving everything. Last updated **2026-08-15** (main @ `5b19906`; open PR #8
has six commits on top, see below).

---

## 1. What this is

A Playwright browser-automation CLI that generates and prints Amazon Seller
Central **product labels (FNSKU / item labels)**. It drives the real Seller
Central web UI — it does **not** use the Amazon Selling Partner API (that's a
possible future direction, deliberately not the current one).

**End goal:** share this with coworkers on the team so they can launch it from
Claude Code or Codex. That means it needs to be installable by a non-author, on
macOS *and* Windows, with each teammate using **their own** Seller Central login.

**Secondary goal stated by the owner:** this project is partly an exercise in
building an MCP server and doing browser automation. Prefer solutions that
exercise those, over shortcuts that skip them (e.g. don't replace scraping with
the SP-API just because it'd be easier).

- Repo: `DarienDuong/Seller-Central-Label-Printing-Automation`
- Local path: `/Users/d0d0288/Desktop/Label Printing Browser Automation`
- Stack: TypeScript (ESM) + `tsx`, Playwright (Chromium), Node 22 via nvm
- No test framework yet. `npm run typecheck` (`tsc --noEmit`) is the only gate.

---

## 2. Current status

**Phases 1–3 are done and verified against a live account.** Phase 4 is
"make it shareable" — Part A is merged, Part B is implemented and awaiting
live verification + review on an open PR.

| Phase | Scope | State |
| --- | --- | --- |
| 1–3 | login, print by SKU, `--file` batches, `list` inventory | ✅ done, live-verified |
| 4A | **shipment mode** (`--shipment`) | ✅ done, merged in PR #6 |
| 4B | **Windows printing support** | 🟡 implemented + typechecked, **open PR #8**, unverified on a real Windows box/printer |
| 4C | **MCP server** | ⬜ not started |
| 4D | **teammate onboarding docs** | ⬜ not started |

Sequencing 4B/4C/4D was the owner's call: shipment mode first (done), the rest
after. Confirm with the owner before starting any of C/D.

`main` (`5b19906`) contains Phases 1–3, 4A, and the Claude Code GitHub Actions
review workflow (PRs #9, #11, #12 — automated PR review, not a project phase).
**`feat/windows-printing` (PR #8, open) has 4B on top of it** — not yet merged,
not yet run against a real Windows machine, currently up to date with `main`
(no rebase needed). Start a fresh session from `main` only if 4B isn't the
task; otherwise check out/continue that branch.
PR #4 ("Added my print label script in project sub-directory") is still **open**
and is a stale/superseded PR from before the rewrite — check with the owner
before touching it.

---

## 3. Commands

```bash
nvm use && npm install && cp .env.example .env   # setup
npm run login                                     # interactive, saves .auth/
npm run print -- --sku ABC-123 --qty 30 --dry-run
npm run print -- --file data/products.json --dry-run
npm run print -- --shipment <wf-id-or-URL> --dry-run
npm run shipment -- --shipment <wf-id>            # read-only, prints nothing
npm run list -- --search "coffee"
npm run typecheck
```

Common flags: `--dry-run` (download PDF, never print), `--headed`, `--json`,
`--format <fmt>`, `--printers`.

---

## 4. Layout

| Path | Role |
| --- | --- |
| `src/cli.ts` | arg parsing; `login` / `print` / `shipment` / `list` |
| `src/config.ts` | `.env` loading, Seller Central URL builder |
| `src/browser.ts` | Chromium launch + saved-session context (`Session` type) |
| `src/auth.ts` | interactive login, session detection, `gotoAuthed()` |
| `src/pages/inventoryPage.ts` | Manage Inventory + Print Item Labels page object |
| `src/pages/shipmentPage.ts` | Send to Amazon content step — scrapes a shipment's SKUs/units |
| `src/tasks/printLabels.ts` | group by format → print page → set quantities → submit → save |
| `src/tasks/shipmentLabels.ts` | workflow id → `LabelRequest[]`, and the combined print path |
| `src/printer.ts` | Printer handoff — CUPS `lp`/`lpstat` on macOS/Linux, PowerShell/`Win32_Printer` on Windows (4B, PR #8, unmerged) |
| `src/types.ts` | `LabelRequest`, `LabelResult`, `ShipmentItem`, `InventoryItem`, `LabelFormat` |

~1,400 lines of TypeScript total (on `feat/windows-printing`; ~1,140 on
`main` before 4B). Small enough to read end to end.

---

## 5. Hard-won findings — read before touching Seller Central selectors

These cost real debugging time. Don't rediscover them.

### Print flow
- The print page takes SKUs **in the query string**:
  `/fba/printitemlabel/?mSku.0=<sku>&mSku.1=<sku>…` — one row per SKU with its own
  quantity field. This bypasses the Manage Inventory grid entirely.
- SKUs sharing a format are batched into **one PDF** per run per format.
- **Unknown/invalid SKUs are silently dropped** with no error.
  `renderedSkus()` diffs requested vs rendered to catch this.
- Everything is shadow-DOM Katal (`kat-*`) web components. Playwright's default
  locators pierce open shadow roots — no special handling needed.
- "Standard formats" = fixed Paper/Sticker dropdown (30/27/24/21/40/44-up).
  "Thermal printing" swaps that for freeform Width/Height mm fields (Amazon's
  own default 57×32mm). There is no fixed thermal preset.
- Manage Inventory rows have **no fixed text column layout** — out-of-stock rows
  carry an extra "Replenish inventory" line that shifts everything after it.
  `listVisible()` indexes by adjacent label line, not position.

### Shipment mode (`src/pages/shipmentPage.ts`)
- Keyed by **workflow id** (`wf…`) from the Send to Amazon URL, **not** the
  `FBA…` shipment id — an in-progress workflow has no `FBA…` id yet.
- Two tabs. Default is "All FBA SKUs" = your **entire catalogue** with empty
  quantities. Shipment contents are on **"SKUs ready to send (N)"**, where
  quantities render as *text* ("Units: 198"), not inputs.
- **Pagination is a trap.** On the ready-to-send tab the pager's `total-items`
  is the count of rows *currently rendered*, not the shipment total (12-SKU
  shipment at 10/page reports `total-items=10`). Because it reports
  `total == pageSize`, the widget concludes there's one page and renders **no
  next/prev controls at all**. So: `total-items` is useless as a completeness
  check, and there is nothing to click through to page 2. The trustworthy total
  is the **tab label** `SKUs ready to send (N)`. Current strategy: read N from
  the label, request page size 100 (the max), require exactly N rows, fail
  loudly otherwise.
- **Page size must be set BEFORE switching tabs.** Changing it re-queries the
  list and resets to the All-FBA tab, silently discarding the switch — seen live
  as `Read 1 of 1429 SKUs`.
- **Scope every locator to a container.** An unscoped `kat-option` locator picks
  from ~76 options across the page's other dropdowns, lands on one inside a
  *closed* dropdown, and blocks until the action timeout. This is how page size
  silently never applied at all for a while. Use
  `kat-dropdown[data-testid="page-size-dropdown"]` / `kat-tab` as the scope.
- **Don't wait on `.sku-row-sku-details` counts** — the other tab's rows are in
  the DOM too, so that condition is satisfied by hidden All-FBA rows while
  ready-to-send rows are still painting (`Read 1 of 12`). Poll the real
  `extractRows()` instead, which only counts rows carrying a `Units:` value.
- The page is **genuinely slow** — 15–20s to first paint; a full `--shipment`
  run is ~60s. That's not a hang. Waits here are deliberately long.
- `SHIPMENT_PAGE_SIZE` env var exists **only** as a debug knob to exercise the
  doesn't-fit-on-one-page path against a normal-sized shipment.

### Dead ends — already tried, don't repeat
- **Guessing internal JSON endpoints.** Every guessed path returned HTTP 200 —
  but `content-type: text/html`, i.e. the SPA shell. Always check content-type
  before believing a 200.
- **Scanning JS bundles for endpoints** returned 0 hits, which was a **false
  negative** caused by CORS ("Failed to fetch"), not an actual absence.
- **The new React Shipments list** (`/amazonsell/shipments`) frequently hangs
  outright — it never finished loading via the Chrome connector across many
  attempts. Playwright renders it fine. `/fba/inbound-queue` is a 404; the real
  path is `/gp/ssof/shipping-queue.html/`, which redirects to `/amazonsell/shipments`.

---

## 6. Constraints — these are firm

- **`.auth/seller-central.json` is a live Seller Central session.** Gitignored.
  Treat it like a password. **Never** copy it between machines — each teammate
  runs `npm run login` themselves.
- The script **never types the user's password** and **never handles OTP/2FA**.
  A human does the sign-in in a real window; the script only detects and saves
  the resulting session.
- Shipment work is **read-only** against live open shipments. Never confirm,
  modify, or advance a workflow.
- OAuth flows (`gh auth login`, Amazon login) are performed by **the user**, not
  by the agent.
- Automating Seller Central is subject to Amazon's terms — keep the pace human,
  don't run it as a scraper, expect occasional bot checks needing a headed window.

---

## 7. Open threads / next work

**4B — Windows support.** `src/printer.ts` now branches on `os.platform()`.
Windows has no CLI equivalent of `lp -d <printer>`, so the approach is:
resolve `PRINTER_NAME` to Windows's own exact printer-name string, flip the
default printer to it (`Win32_Printer.SetDefaultPrinter` via PowerShell +
CIM, read back to confirm), fire `Start-Process -Verb Print` once per copy
(the registered PDF handler's print verb, which only ever targets the
default printer), **poll the target printer's job queue** (`Get-PrintJob`,
by job id, run as a single PowerShell process per wait rather than one
process per poll tick) until the job actually appears — up to 60s, falling
back to a fixed 15s hold only if the queue can't be read — then restore the
previous default printer. `--printers` lists `Win32_Printer` names on
Windows. Implemented and typechecked on `feat/windows-printing` (**open PR
#8**) but **not yet run against a real Windows machine with a physical
printer** — the owner doesn't have warehouse PC access this session. Treat
the first live run as the real test: use `--dry-run` first, confirm
`PRINTER_NAME` matches `Get-CimInstance Win32_Printer`, and watch the job
land in the Windows print queue.

The fixed-timer design (a flat sleep instead of polling the queue) was
tried and reverted after review — it raced the async PDF handler and could
restore the default before the job was actually submitted, printing
silently to the wrong device. Don't reintroduce a fixed sleep as the
primary wait; the `HANDOFF_FALLBACK_MS` fixed wait is deliberately a
fallback only, used when `Get-PrintJob` itself is unavailable.

Known rough edges, both already surfaced with a log line rather than
silently occurring:
- If the process is killed mid-print, the Windows default printer can be
  left pointed at `PRINTER_NAME` instead of restored.
- If the machine had **no** default printer before the run (common on
  freshly imaged / kiosk-style PCs), there's no "unset the default" API to
  restore to — `PRINTER_NAME` is left as the new default even after a clean
  run, with a warning logged.

Also fixed along the way, in `src/tasks/printLabels.ts` (not Windows-specific,
but surfaced by the Windows work adding new throw sites — e.g. a stale
`PRINTER_NAME` — inside the print call): `sendToPrinter`'s failure used to be
caught by the group-wide `catch`, which re-recorded every SKU in the group as
`'failed'`, clobbering SKUs already recorded `'skipped'` earlier in the same
group and discarding `pdfPath` for SKUs whose PDF was actually saved fine.
Now wrapped in its own try/catch so a printer failure records `'downloaded'`
+ `pdfPath` + the error, and each group tracks which SKUs already have a
result so the outer catch can't re-record them.

PR #8 has been through three rounds of automated review (all findings
confirmed and fixed, no pushback needed) — see the PR thread for the full
list. Nothing outstanding on the review side; the only gate left is a real
Windows run.

Still open: setup docs need `nvm-windows` notes — it ignores `.nvmrc`.

**4C — MCP server.** Expose `print_labels`, `list_inventory`,
`print_shipment_labels`, and a session-status check. stdio transport is the
right call for the stated hosts (Claude Code, Claude Desktop, Codex CLI).
Registration: `claude mcp add` for Claude Code, `config.toml` for Codex.
Note: a *remote* HTTPS server would be needed for ChatGPT connectors/apps, and
GPT Actions is a separate non-MCP protocol — out of scope unless asked.

**4D — onboarding docs.** repo access → install → `.env` → their own
`npm run login` → MCP registration, with per-OS notes.

**Unresolved bug report.** The owner once reported
`Target page, context or browser has been closed` with `shipmentToRequests` in
the stack trace. That function no longer exists — the trace was stale
scrollback, and a clean run passed in 62s. It was never confirmed whether the
error still reproduces on current code. If it resurfaces, suspect the visible
Chromium window being closed or interfered with during the ~60s wait
(`BROWSER_MODE=headed` is the `.env.example` default).

---

## 8. Working agreements observed so far

- Work goes on a **feature branch** → pushed → **PR against main**, never
  committed straight to main.
- PRs get automated review comments. The expectation is: evaluate each finding,
  implement the valid ones, and **challenge the invalid ones in a reply comment**
  rather than silently complying. (This has paid off — acting on review findings
  in PR #6 uncovered three real bugs that the findings themselves hadn't spotted.)
- README is kept current as part of the change, not afterwards.
- Verification means checking the **actual artifact** (open the PDF, count the
  pages, count distinct FNSKUs), not "no error thrown".
