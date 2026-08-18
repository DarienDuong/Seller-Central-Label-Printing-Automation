# Project context & status

Handoff doc for starting a fresh Claude Code / Codex session on this repo without
re-deriving everything. Last updated **2026-08-16** (main @ `184c215`, which
includes PR #8 / 4B; **open PR #13**, branch `fix/windows-printing-followups`,
has follow-up fixes on top — see below).

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
"make it shareable" — Parts A and B are merged into `main`; B has follow-up
fixes on an open PR, still gated on a real Windows run.

| Phase | Scope | State |
| --- | --- | --- |
| 1–3 | login, print by SKU, `--file` batches, `list` inventory | ✅ done, live-verified |
| 4A | **shipment mode** (`--shipment`) | ✅ done, merged in PR #6 |
| 4B | **Windows printing support** | 🟡 merged (PR #8), **open follow-up PR #13**, still unverified on a real Windows box/printer |
| 4C | **MCP server** | ⬜ not started |
| 4D | **teammate onboarding docs** | ⬜ not started |

Sequencing 4B/4C/4D was the owner's call: shipment mode first (done), the rest
after. Confirm with the owner before starting any of C/D.

`main` (`184c215`) contains Phases 1–3, 4A, 4B (PR #8, squash-merged — its
branch history isn't preserved on `main`, so don't try to rebase onto it
expecting a fast-forward; cherry-pick instead), and the Claude Code GitHub
Actions review workflow (PRs #9, #11, #12, #14 — automated PR review and its
own upkeep, not a project phase). **`fix/windows-printing-followups` (PR
#13, open)** carries everything from #8's review that landed after #8 had
already merged, plus several more rounds of review on #13 itself —
job-identity matching in the print-queue poll (by `DocumentName`
substring, not job id), surfacing unconfirmed print handoffs as structured
data instead of plain-text prose or silent success, routing all log output
to stderr so `--json` is actually pipeable, and this file's own accuracy
(multiple times — it kept drifting behind the code each round). Start a
fresh session from `main` only if 4B isn't the task; otherwise check
out/continue that branch.
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
| `src/printer.ts` | Printer handoff — CUPS `lp`/`lpstat` on macOS/Linux, PowerShell/`Win32_Printer` on Windows (4B, merged in PR #8, follow-ups in PR #13) |
| `src/logger.ts` | Console logger — everything writes to stderr so `--json`'s stdout stays pure JSON |
| `src/types.ts` | `LabelRequest`, `LabelResult`, `ShipmentItem`, `InventoryItem`, `LabelFormat` |

~1,570 lines of TypeScript total (on `fix/windows-printing-followups`;
~1,140 on `main` before 4B). Small enough to read end to end.

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
Windows. Implemented and typechecked, merged in PR #8 with follow-ups in PR
#13, but **not yet run against a real Windows machine with a physical
printer** — the owner doesn't have warehouse PC access this session. Treat
the first live run as the real test: use `--dry-run` first, confirm
`PRINTER_NAME` matches `Get-CimInstance Win32_Printer`, watch the job land
in the Windows print queue, and check the logged `Queue check for copy
N/M: matched|unmatched|none` line — a run that's consistently `unmatched`
(not `matched`) means the DocumentName substring check isn't firing on
that PDF handler (and the run is paying the full 60s/copy for it) and is
worth a follow-up fix.

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
