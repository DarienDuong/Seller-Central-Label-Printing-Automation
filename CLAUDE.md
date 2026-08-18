# Seller Central Label Printing Automation

Playwright CLI that prints Amazon Seller Central FNSKU/item labels by driving the
real web UI (not the SP-API).

**Read [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) before doing anything
non-trivial.** It carries the current phase status, the Seller Central DOM
findings that cost real debugging time (shipment pagination is a trap, locators
must be container-scoped, page size must be set before tab switches), and the
dead ends already ruled out.

## Fast facts

- Node 22 (`nvm use`), TypeScript ESM + `tsx`, Playwright Chromium.
- `npm run typecheck` is the only automated gate — there are no tests.
- Entry points: `npm run login | print | shipment | list`. `--dry-run` downloads
  the PDF without printing; use it for anything exploratory.

## Rules

- `.auth/seller-central.json` is a live Seller Central session. Gitignored, never
  copied between machines, treated like a password.
- Never type the user's password; never handle OTP/2FA. The human signs in.
- Shipment pages are **read-only** — never confirm, modify, or advance a live
  workflow.
- Feature branch → push → PR against `main`. Never commit directly to `main`.
- Verify against the real artifact (open the PDF, count pages/FNSKUs), not
  "no error thrown".
- **Docs are part of the diff, not a follow-up commit.** Before calling any
  code change done — and always before opening or updating a PR — check
  whether it invalidates something [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md)
  or README.md currently states, and fix it in the same commit. Concretely,
  re-check these every time `src/` changes, a PR opens/merges, or a branch
  changes:
  - The phase/status table and "Current status" narrative in PROJECT_CONTEXT.md §2.
  - Any PR number, merge state, or branch name mentioned anywhere in either
    file — these go stale the moment a PR merges or a new one opens.
  - Mechanism descriptions in PROJECT_CONTEXT.md §7 ("Open threads") and any
    matching section of README.md — if you changed *how* something works,
    the prose describing how it works is now wrong until you fix it.
  - `main`'s head commit hash in PROJECT_CONTEXT.md's header line.
  This has slipped repeatedly in past sessions — reviewers keep finding
  stale docs in the same PR that introduced the drift. Treat this as a hard
  checklist item on every non-trivial task, not something to remember to
  get to.
