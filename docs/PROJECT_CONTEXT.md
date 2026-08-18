# Project context & status

Handoff doc for starting a fresh Claude Code / Codex session on this repo without
re-deriving everything. Last updated **2026-08-18** (main @ `7e5340b`, which
includes PR #8 / 4B and its follow-ups from PR #13, plus the verified-printer
doc pass in PR #17 — all merged, see below).

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

**Where this is headed eventually** (not current scope — see §9): a private
service holding SP-API credentials that employees authenticate *to*, and an MCP
server over Seller Central covering many actions rather than just labels. Today
the point is hands-on exposure to building an MCP server, with browser
automation as the mechanism. §9 records the SP-API research so it doesn't get
re-derived — and why the browser-session model stays until that service exists.

- Repo: `DarienDuong/Seller-Central-Label-Printing-Automation`
- Local path: `/Users/d0d0288/Desktop/Label Printing Browser Automation`
- Stack: TypeScript (ESM) + `tsx`, Playwright (Chromium), Node 22 via nvm
- No test framework yet. `npm run typecheck` (`tsc --noEmit`) is the only gate.

---

## 2. Current status

**Phases 1–3 are done and verified against a live account.** Phase 4 is
"make it shareable" — Parts A and B are fully merged into `main`. B's
macOS/CUPS path is now live-verified too; Windows is the only piece of 4B
still unverified on real hardware.

| Phase | Scope | State |
| --- | --- | --- |
| 1–3 | login, print by SKU, `--file` batches, `list` inventory | ✅ done, live-verified |
| 4A | **shipment mode** (`--shipment`) | ✅ done, merged in PR #6 |
| 4B | **Windows printing support** | 🟡 merged (PR #8 + follow-ups in PR #13). macOS/CUPS path live-verified 2026-08-18; **Windows still unverified on real hardware** |
| 4C | **MCP server** | ⬜ not started |
| 4D | **teammate onboarding docs** | ⬜ not started |
| 5 | **one sheet per SKU by default** (`--combine` opts back into today's behavior) | ⬜ planned, not started — live exploration done, see §7 |

Sequencing 4B/4C/4D was the owner's call: shipment mode first (done), the rest
after. Confirm with the owner before starting any of C/D.

**Phase 5 should land before 4C.** It adds a flag to the `print` surface, and
4C's MCP tool schema wraps that surface — building the schema first means
reworking it immediately after.

`main` (`7e5340b`) contains Phases 1–3, 4A, 4B (PR #8 and its follow-ups in
PR #13, both squash-merged — their branch history isn't preserved on `main`,
so don't try to rebase a leftover branch onto it expecting a fast-forward;
cherry-pick instead), and the Claude Code GitHub Actions review workflow
(PRs #9, #11, #12, #14, #15 — automated PR review and its own upkeep, not a
project phase), the context doc you're reading (PR #7), and a doc-accuracy
pass in PR #17. PR #13 carried everything from #8's review that landed
after #8 had already merged, plus several more rounds of review on #13
itself — job-identity matching in the print-queue poll (by `DocumentName`
substring, not job id), surfacing unconfirmed print handoffs as structured
data instead of plain-text prose or silent success, routing all log output
to stderr so `--json` is actually pipeable, and this file's own accuracy
(multiple times — it kept drifting behind the code each round).
PR #4 ("Added my print label script in project sub-directory") — the
stale/superseded PR from before the rewrite — is now **closed**
(2026-08-17). Nothing further to do with it.

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
| `src/printer.ts` | Printer handoff — CUPS `lp`/`lpstat` on macOS/Linux, PowerShell/`Win32_Printer` on Windows (4B, merged in PR #8, follow-ups in PR #13) |
| `src/logger.ts` | Console logger — everything writes to stderr so `--json`'s stdout stays pure JSON |
| `src/types.ts` | `LabelRequest`, `LabelResult`, `ShipmentItem`, `InventoryItem`, `LabelFormat` |

~1,570 lines of TypeScript total on `main` (~1,140 before 4B merged).
Small enough to read end to end.

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
- **The Manage Inventory route to printing is redundant, not useful** (checked
  live 2026-08-18, because it's a reasonable idea that deserves a real answer).
  Searching the grid by SKU does work cleanly — it returns `1 - 1 of 1`. But
  the per-row `⋮` menu has **no** print option at all; "Print item labels"
  lives in the *group action* menu (tick the row's checkbox first), and
  clicking it opens
  `/fba/printitemlabel/?mSku.0=<sku>&ref_=myp_printitemlabels` — the exact URL
  this codebase already builds, plus a tracking ref. So the grid route is ~6 UI
  steps to reach a URL we construct in one line from the SKU, and it lands on
  the same page, so it yields the same packed PDF and doesn't help with
  per-SKU sheet breaks either. It also puts an automated click in a menu where
  "Delete listing" and "Close listing" sit four rows above the target — avoid,
  on the read-only grounds in §6.
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
  before believing a 200. **What does work is observing real traffic**: patch
  `window.fetch` in the live page, click the control, read the captured URL and
  body. That's how `POST /fba/printitemlabel/ping/getPdfContent` (raw PDF bytes
  out, `msku`+`quantity` in) was found — see the Phase 5 write-up in §7.
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
run as a single PowerShell process per wait rather than one process per poll
tick) until *our* job appears, then restore the previous default printer.
"Ours" is matched by `DocumentName` against the PDF's file name (a
case-insensitive *substring* check — `IndexOf`, not `EndsWith` — since a
suffix check only covers a handler that sets `DocumentName` to the full
path, and misses Edge's own decoration, `name.pdf - Profile 1 - Microsoft
Edge`, where the file name is a prefix, not a suffix; Edge is the handler
this is actually gated on), not just any new job id — an any-new-id test
let a concurrent job from another machine on a shared printer satisfy the
wait and release the default early. A name match returns immediately —
that's the fast path, and the one that matters for run time: a `matched`
copy returns as soon as the job shows up, but a copy that ends `unmatched`
or `none` blocks for the **full poll timeout (60s)** before the default
printer is restored, since there's no other way to be sure nothing more
will show up. On a multi-copy or multi-group run, `unmatched`/`none`
becoming the steady state (not the exception) is what turns a few-second
operation into minutes — that's the concrete cost of a mismatch, not just
a warning. When the deadline passes with new jobs seen but none matching by
name, or nothing new at all, the send is still reported as successful but
flagged `unconfirmed` with a reason (not a hard failure — a one-page label
can spool and clear the queue between polls, and a false failure invites a
duplicate reprint of the batch). Falls back to a fixed 15s hold only if the
queue can't be read at all. `--printers` lists `Win32_Printer` names on
Windows. Implemented, typechecked, and merged (PR #8 + follow-ups in PR
#13), but **still not run against a real Windows machine with a physical
printer** — the owner doesn't have warehouse PC access. Treat the first
live run as the real test: use `--dry-run` first, confirm `PRINTER_NAME`
matches `Get-CimInstance Win32_Printer`, watch the job land in the Windows
print queue, and check the logged `Queue check for copy N/M:
matched|unmatched|none` line — a run that's consistently `unmatched` (not
`matched`) means the DocumentName substring check isn't firing on that PDF
handler (and the run is paying the full 60s/copy for it) and is worth a
follow-up fix.

**The macOS/CUPS side of this same code IS now live-verified** (2026-08-18,
on `main` @ `6803398`): `npm run print --dry-run` against two representative
SKUs from the live account (quantities 2 and 22) produced correct 30-up
PDFs, and a real (non-dry-run) print of one of them (qty 1) to a real CUPS
printer (`Brother_DCP_L2550DW_series`) was confirmed to physically print
correctly. This also verified, live rather than just by reading the diff:
`--json` output is clean parseable JSON with no log noise mixed in
(confirms the logger-to-stderr fix), and a confirmed print correctly
reports `status: 'printed'` with no `message`/`unconfirmed`. Only Windows
remains unverified.

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
Now wrapped in its own try/catch so a printer failure records `pdfPath` +
the error instead of losing them. That failure is its own status —
`'print-failed'`, added to `LabelResult` — not `'downloaded'`: an earlier
version of this fix recorded it as `'downloaded'`, which preserved
`pdfPath` but also meant `cli.ts`'s exit-code check (`status === 'failed'`)
no longer caught it, so a printer misconfiguration silently exited 0.
Review caught that regression; `'print-failed'` is checked alongside
`'failed'` in `cli.ts`, and `'downloaded'` now means only "printing was
never attempted" (dry run, or `PRINTER_NAME` unset) — each group also
tracks which SKUs already have a result so the outer catch can't
re-record them.

Two more rounds landed on top of that, both on PR #13 (not #8, which was
already merged by then):

- **`unconfirmed` as structured data, not prose.** `sendToPrinter` returns
  `SendResult` (`{ sent, unconfirmed? }`) instead of a bare boolean — a
  Windows send that couldn't be confirmed (an `'unmatched'`/`'none'` queue
  check, or an unreadable queue) sets `unconfirmed` to the reason instead of
  silently reporting plain success. `LabelResult` grew a matching
  `unconfirmed?: string` field, kept separate from `message` on purpose —
  folding it into `message` (an earlier version of this fix did that) meant
  a `--json` consumer could only tell a confirmed `'printed'` from an
  unconfirmed one by string-matching English prose. Exit code deliberately
  untouched by `unconfirmed`: it's not proof of failure, and treating it as
  one invites a duplicate reprint of the whole batch.
- **`src/logger.ts` now routes everything to stderr.** `info`/`step`/`done`
  used to go through `console.log` — the same stream `cli.ts`'s `--json`
  writes its `JSON.stringify(...)` output to — so every progress line
  logged during a run (including the `Queue check for copy N/M: ...` line
  above) landed in front of the JSON blob, and `npm run print -- ... --json
  | jq ...` couldn't parse stdout at all. `unconfirmed` as a structured
  field was pointless until this was fixed, since nothing could read it back
  out.

PR #8 was through four rounds of automated review before merging — most
findings confirmed and fixed outright, one (the `'downloaded'`-vs-exit-code
point above) genuine pushback that changed the design mid-PR rather than a
rubber-stamp. PR #13 has been through several more rounds on top of that
(7 commits as of `e261995`), including the two just described. See each
PR's thread for the full list. Nothing outstanding on the review side as of
this commit; the only gate left is a real Windows run.

Still open: setup docs need `nvm-windows` notes — it ignores `.nvmrc`.

**4C — MCP server.** Expose `print_labels`, `list_inventory`,
`print_shipment_labels`, and a session-status check. stdio transport is the
right call for the stated hosts (Claude Code, Claude Desktop, Codex CLI).
Registration: `claude mcp add` for Claude Code, `config.toml` for Codex.
Note: a *remote* HTTPS server would be needed for ChatGPT connectors/apps, and
GPT Actions is a separate non-MCP protocol — out of scope unless asked.

**4D — onboarding docs.** repo access → install → `.env` → their own
`npm run login` → MCP registration, with per-OS notes.

**Phase 5 — one sheet per SKU by default.** Planned 2026-08-18, not started.

*The problem.* Today a run puts every SKU that shares a format onto one
print-labels page load, and Amazon packs the resulting labels **contiguously**
— a SKU's labels start wherever the previous SKU's ended, mid-sheet. Confirmed
arithmetically by the verified 12-SKU shipment: 2433 units came back as 82
pages, and `ceil(2433 / 30) = 82` exactly, which is only possible with no
per-SKU sheet breaks. Physically that means a stack of sheets that can't be
split by SKU without reading barcodes, which is the actual complaint.

*Amazon has no native option for this — established, not assumed* (explored
2026-08-18 via the Chrome connector against the live account):

- Every form control on `/fba/printitemlabel/`, shadow roots included, is: one
  quantity input per SKU, the two format dropdowns, and the submit button.
  There is no checkbox, toggle, or hidden field for sheet breaks.
- The "Print Item Labels" button does **not** post a form. It calls
  `POST /fba/printitemlabel/ping/getPdfContent` with
  `{itemLabelDataList:[{fnsku,msku,quantity}…], labelType, pageType, width,
  height}` and gets **raw PDF bytes** back (`%PDF-`, 200). This was captured
  from the page's own traffic by patching `window.fetch` — it is *not* a
  guessed endpoint (see the endpoint-guessing dead end in §5; observing real
  traffic is the technique that works, guessing is the one that doesn't).
- `labelType` is a real enum, and all three values were tested by page count:
  `MULTIPLE` = standard N-up, packing contiguously across SKUs (A+B at qty 1
  each → **1 page**; A at 30 + B at 1 → 2 pages, i.e. B spills onto sheet 2);
  `SINGLE` = one label **per page** (A at qty 3 → 3 pages — a tempting name,
  but it would turn a 2433-unit shipment into 2433 sheets, not 12);
  `SINGLE_MULTILINE` = thermal (captured from the UI's own thermal mode).
  Invalid values 500.
- Speculative page-break params (`newPagePerSku`, `separatePages`,
  `pageBreakPerSku`, `onePagePerSku`, per-item `startNewPage`) all returned
  **byte-identical** PDFs. **Don't read too much into this, and don't spend
  time guessing more names.** The endpoint accepts unknown JSON properties
  without erroring, so a null result can't distinguish "no such feature" from
  "wrong name", and the space of names is unbounded — it's the same trap as
  the endpoint-guessing dead end in §5. What actually settles the question is
  the *published* SP-API schema (§9): `createMarketplaceItemLabels` mirrors
  this endpoint field for field and its complete request body has no
  page-break parameter either. The `labelType` enum result above is the other
  real evidence — `SINGLE` does change behavior, which shows the enum is the
  axis Amazon exposes for layout, and it isn't per-SKU.

So sheet separation has to be done client-side. **Merging per-SKU PDFs is the
only route.**

*The change.* Default becomes: fetch one PDF per SKU, then **concatenate them
into a single PDF** — each source PDF already ends on a sheet boundary, so
concatenation gives per-SKU sheet breaks for free, in **one file and one
printer job**. `--combine` opts back into today's packed behavior (fewer
sheets, no per-SKU breaks). `groupByFormat()` in `src/tasks/printLabels.ts` is
where this is decided. Flag only, deliberately no `.env` default — a
per-machine setting that silently changes how paper comes out is a support
burden. `--shipment` inherits the new default, which is the case that matters
most.

*Get the PDFs from the API, not from N page loads.* Calling `getPdfContent`
directly averaged **263 ms**, so a 12-SKU shipment costs ~3 s of requests
rather than the ~3–5 minutes that 12 full page loads would take. Two findings
make this simpler than expected: **`fnsku` is ignored** — omitted, empty, and
deliberately wrong values all produced identical bytes, so the server resolves
the barcode from `msku` and we never need to scrape FNSKUs; and an unknown
`msku` returns **500** rather than being silently dropped, which is strictly
better than the DOM path's silent-drop behavior that `renderedSkus()` exists
to detect. `pageType` values are already exactly our `LabelFormat` strings.

*The private endpoint is the approved route* (owner decision, 2026-08-18). It
is undocumented and can change without notice, but three things make it a
reasonable dependency: the call runs inside the authenticated browser session
via `page.evaluate`, so it stays session-driven rather than becoming an SP-API
integration; the DOM path (one page load per SKU at
`/fba/printitemlabel/?mSku.0=<sku>`) remains as a fallback that produces
byte-identical PDFs, just slower; and it has a documented, supported twin in
SP-API — `createMarketplaceItemLabels` takes the same inputs under different
names (see §9), so this is the internal version of a real API, not a hack
around a missing one. If Amazon changes it, the fallback and the migration
target are both already known.

*Implementation notes.* Merging needs a PDF library — `pdf-lib` is pure JS
with no native deps, which matters because 4B's Windows support is still
unverified and a native build step would make that worse. Response bytes must
be read as `arrayBuffer` (base64 across the `page.evaluate` boundary), **not**
`text()`, which mangles binary. Keep the pace deliberate between requests per
the Amazon-terms constraint in §6.

*Verification.* Per §8, against the artifact, not the absence of errors: one
PDF per SKU, each `ceil(qty / 30)` pages, and — the actual claim — the first
label of each PDF sitting at sheet position 1. Total label count must be
unchanged, and `--combine` must reproduce the 82-page baseline exactly.

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
- README **and this file** are kept current as part of the change, not
  afterwards. This slipped repeatedly during PRs #13 — reviewers found
  stale status tables, wrong PR numbers, and mechanism descriptions that
  described a previous commit's behavior, in the same PR that caused the
  drift, more than once. Concretely: after any change to `src/`, or when a
  PR opens/merges/rebases, re-check §2's status table, any PR
  number/branch name/merge state mentioned anywhere in this file or
  README.md, and §7's mechanism write-ups against what the code now
  actually does — before considering the task finished, not as a
  follow-up once a reviewer points it out.
- Verification means checking the **actual artifact** (open the PDF, count the
  pages, count distinct FNSKUs), not "no error thrown".

---

## 9. Long-term direction — SP-API (explicitly NOT current scope)

Researched 2026-08-18. Recorded because it keeps coming up and the reasoning is
easy to re-litigate from scratch. **Nothing here is being built now.**

### Where the project is actually headed

The owner's stated long-term goal is a **private service that holds the SP-API
credentials**, which employees authenticate *to*, plus an **MCP server over
Seller Central** that can call a range of actions and endpoints rather than
just printing labels. That is a substantially larger project than this repo.

The current scope is deliberately smaller: **gaining hands-on exposure to
building an MCP server**, with browser automation as the mechanism. Don't
"helpfully" start the SP-API migration — the browser-automation constraint in
§1 is a learning goal, not an accident of history.

### SP-API does have an item-label endpoint

`POST /inbound/fba/2024-03-20/items/labels` — `createMarketplaceItemLabels`,
in the Fulfillment Inbound 2024-03-20 API: *"For a given marketplace - creates
labels for a list of MSKUs."* It is a near-exact mirror of the private endpoint
Phase 5 uses:

| Private `getPdfContent` | SP-API `createMarketplaceItemLabels` |
| --- | --- |
| `itemLabelDataList: [{msku, quantity}]` | `mskuQuantities: [{msku, quantity}]` |
| `labelType: MULTIPLE` / `SINGLE_MULTILINE` | `labelType: STANDARD_FORMAT` / `THERMAL_PRINTING` |
| `pageType: ItemLabel_Letter_30` | `pageType: Letter_30` |
| `width` / `height` | `width` / `height` (25–100) |

`pageType` accepts `Letter_30`, `A4_27`, `A4_24`, `A4_21`, `A4_40_52x29`,
`A4_44_48x25` — exactly our `LabelFormat` enum minus the prefix — plus five
extra A4 variants Seller Central's own dropdown doesn't offer. It returns
`documentDownloads[]` (presigned URI + expiration) rather than PDF bytes
inline. Capped at 100 MSKUs per call, 2 rps / burst 30.

**It does not solve Phase 5.** The request schema is complete — `height`,
`labelType`, `localeCode`, `marketplaceId`, `mskuQuantities`, `pageType`,
`width` — with no page-break or per-SKU-separation parameter. Same inputs as
the private call, so the same contiguous packing. Merging PDFs client-side is
required under either route.

What SP-API *would* genuinely buy: `listShipmentItems` / `listInboundPlanItems`
would replace shipment-page scraping outright — the tab trap, the `total-items`
lie, the absent pagination controls, and the 60-second page loads in §5 all
become a paginated JSON call.

### The blocker: SP-API has no per-employee credentials

This is the decisive finding, and it's why the browser-session model stays.

- LWA **client id + secret** belong to the *application* — one set.
- The **refresh token** is issued per *selling account*, not per user.
- **"To self-authorize a Seller Central account, you must be the Primary
  User of that account."** Employees are secondary users; they cannot
  authorize an app, and no mechanism exists for them to hold their own
  credential.

So employees could only run SP-API calls by holding *the owner's* credentials.
Compared with what the current design already provides, that is a downgrade in
exactly the dimension that matters:

| | Today (browser sessions) | SP-API with shared credentials |
| --- | --- | --- |
| Identity | Each employee signs in as themselves | Everyone is "the app," acting as the account |
| Amazon's audit trail | Attributes actions to that person | One identity for all |
| Revoking one person | Seller Central → User Permissions; others unaffected | Rotate the token, redistribute to everyone |
| Scope limits | Their assigned Seller Central role | Whatever roles the app was approved for |
| If a credential leaks | Session expires on its own | Refresh token is long-lived and account-wide |

That last row is the sharp one: a stolen `.auth/seller-central.json` is
self-limiting, a leaked refresh token is not. Distributing SP-API credentials
would also mean putting a `client_secret` Amazon expects to stay confidential
onto machines the owner doesn't control.

**The hosted-service design is the resolution, not a workaround** — it's the
standard answer to this exact constraint (don't distribute credentials;
distribute access to a service that holds them), and it happens to be where
the owner already wants to go. Until that service exists, employees keep
browser sessions.

### If someone picks this up later

Load-bearing facts, so they don't get re-derived: the item-label endpoint
exists and mirrors the private one; it does *not* do sheet separation; the
auth model has no per-user credential and requires the Primary User to
authorize; SP-API's real win here is shipment reading, not label generation.

Sources: [Fulfillment Inbound 2024-03-20 API model](https://github.com/amzn/selling-partner-api-models/blob/main/models/fulfillment-inbound-api-model/fulfillmentInbound_2024-03-20.json)
(operation list and schemas above were read directly from it),
[Authorize Private Applications](https://developer-docs.amazon.com/sp-api/docs/self-authorization),
[Usage plans and rate limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
