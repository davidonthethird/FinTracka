# Test Plan

## Strategy

- Domain and repository tests use temporary SQLite databases and real transactions.
- Provider contract tests use deterministic fake adapters; no real financial data or credentials.
- FastAPI tests exercise request/response validation and local-session security.
- Playwright covers user journeys against the synthetic fixture.
- Export tests reopen generated workbooks and compare stable IDs, row counts, and values.

The implementation uses two layers of browser verification: a repository-native TypeScript Playwright test under `frontend/e2e/`, plus `e2e/browser_acceptance.py` for visual capture and accessibility-state diagnostics through the web-app testing helper.

## Synthetic fixture

Three institutions containing checking, savings, and two credit cards; income, ordinary spending, a paired transfer, a credit-card payment, pending/posting replacement, refund, reimbursement, reversal, split, duplicate candidate, provider modification/removal, and a deliberate one-cent reconciliation discrepancy.

## Required cases

- Initial sync and unchanged repeat.
- Modified, removed, pending-to-posted, interrupted, and pagination-restart syncs.
- Exact CSV replay and overlapping different-file review.
- Manual categories/notes/tags preserved through provider mutation.
- Valid, ambiguous, and false-positive transfer matches.
- Refund/reimbursement/reversal reporting.
- Split exactness and rounding rejection.
- Tracking and envelope month/year boundaries.
- Statement reconciliation at zero and one-cent mismatch.
- Google/Excel repeat, update, deletion, stale-tail clearing, formula escaping, and failure recovery.
- Backup restore into an empty directory.
- Malicious Host/Origin, missing CSRF, unexpected JSON fields, oversized CSV, and log-secret scans.
- Concurrent edits using one expected version, invalid rule condition types, more than 100 matching register rows, non-USD currency exponents, and the New York month boundary.

## Acceptance criteria

- Repeat sync keeps canonical count and totals unchanged.
- A provider external ID maps to exactly one canonical transaction.
- Pending-to-posted keeps the canonical ID and user fields.
- Confirmed owned-account transfers contribute zero to income/expense.
- Split children equal the parent to the cent.
- Reconciliation reports zero only for an exact statement.
- Repeat exports contain unique stable IDs and mirror updates/deletions.
- Pre-commit interruption advances neither data nor checkpoint.
- Restored reports and audited row counts equal the source database.
- Secret patterns are absent from Git, SQLite, API responses, browser storage, screenshots, and logs.

## Commands

- Backend: `.venv/bin/python -m pytest -q`
- Frontend unit/type/build: from `frontend`, run `npm test -- --run`, `npm run typecheck`, and `npm run build`.
- Browser: from `frontend` with the project virtual environment active, run `npm run test:e2e`.
- Complete: `./scripts/verify.sh`.

## Implemented verification matrix

- Foundation: exact minor units, timezone dates, UUIDv7 shape, migration idempotency, constraints, `0600` database permissions, and FastAPI worker-thread handoff.
- Synchronization: three institutions, idempotent repeat, modification/removal, pending-to-posted preservation, rollback, checkpoint atomicity, and demo categorization.
- Financial integrity: ordered rules, exact splits, transfers, reporting exclusions, CSV repeat/overlap, refunds, reversals, and one-cent reconciliation failure.
- API/security: one-use bootstrap, cookie flags, Host/Origin/CSRF rejection, strict bodies, a deterministic concurrent optimistic-lock race, typed rule conditions, pagination, atomic bulk edits, reports, reconciliation, jobs, and production static fallback.
- Providers: transactions-only Plaid Link requests, Keychain references, pagination mutation restart, bounded retry, consent repair, and revoke with fake clients only.
- Operations: Excel stable IDs/update/deletion/formula escaping, fake Google bounded replacement, verified backup/restore/retention, process locking, and launchd plist generation.
- Browser: secure onboarding, overview, account editing, filtering, 105-row cursor pagination, atomic bulk categorization, splitting, transfer confirmation, editing both budgets, reports, rule preview/creation, visible repair state, Excel export, backup, dark mode, keyboard focus, HTTP failures, console errors, and page errors.

The latest verification run is recorded in Git history rather than treated as permanent evidence; rerun `scripts/verify.sh` for the current checkout before release.
