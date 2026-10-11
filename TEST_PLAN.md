# Test Plan

## Strategy

- Domain and repository tests use temporary SQLite databases and real transactions.
- Provider contract tests use deterministic fake adapters; no real financial data or credentials.
- FastAPI tests exercise request/response validation and local-session security.
- Playwright covers user journeys against the synthetic fixture.
- Export tests reopen generated workbooks and compare stable IDs, row counts, and values.

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
- Frontend unit/build: `npm test -- --run` and `npm run build`
- Browser: `npm run test:e2e`
- Complete: `./scripts/verify.sh` once that script exists.

