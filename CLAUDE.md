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
