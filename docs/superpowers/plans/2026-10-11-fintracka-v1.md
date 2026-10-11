# FinTracka v1 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Apply superpowers:test-driven-development to each behavior and superpowers:verification-before-completion before claiming completion.

**Goal:** Deliver a localhost-only, single-user personal-finance application whose SQLite ledger, synchronization behavior, audit trail, budgets, reports, exports, backups, and synthetic user interface satisfy the approved FinTracka plan without connecting live financial accounts.

**Architecture:** A Python package owns exact money/date handling, numbered SQLite migrations, repositories, domain services, provider adapters, exports, backups, and a FastAPI boundary. A React/TypeScript/Vite frontend consumes `/api/v1`; the production build is served by FastAPI. Provider and spreadsheet clients stay behind narrow interfaces so all automated verification uses synthetic data or fakes.

**Tech Stack:** Python 3.11+ for synthetic development (Python 3.14 required before live data), stdlib `sqlite3`, FastAPI/Pydantic, pytest, React/TypeScript/Vite, React Router, TanStack Table, Recharts, Playwright, OpenPyXL, keyring, and optional Plaid/Google SDKs.

---

## Task 1: Freeze the planning package and project skeleton

**Files:**
- Create: `pyproject.toml`
- Create: `src/fintracka/__init__.py`
- Create: `tests/conftest.py`
- Modify: `.gitignore`
- Verify: the ten root planning documents

1. Add a packaging configuration with a `src` layout, pytest settings, and a `fintracka` CLI entry point.
2. Add the package marker and test fixtures directory.
3. Verify all planning documents exist, cross-link correctly, and contain no unresolved placeholders.
4. Run `pytest` to establish the empty-suite baseline.
5. Commit the planning package and skeleton.

## Task 2: Build the exact ledger foundation

**Files:**
- Create: `tests/test_foundation.py`
- Create: `src/fintracka/ids.py`
- Create: `src/fintracka/money.py`
- Create: `src/fintracka/dates.py`
- Create: `src/fintracka/db.py`
- Create: `src/fintracka/migrations/001_initial.sql`

1. Write failing tests for UUIDv7 text IDs, exact decimal-to-minor conversion, local-date derivation, SQLite pragmas, and migration idempotency.
2. Implement the smallest exact types and migration runner using the standard library.
3. Materialize the complete approved schema with foreign keys, enum/date/currency checks, external-ID uniqueness, split guards, indexes, audit tables, and migration history.
4. Run the focused and full Python suites.
5. Commit the ledger foundation.

## Task 3: Implement provider-neutral atomic synchronization

**Files:**
- Create: `tests/test_sync.py`
- Create: `src/fintracka/providers.py`
- Create: `src/fintracka/sync.py`
- Create: `src/fintracka/synthetic.py`

1. Write failing tests for three-bank fixtures, initial import, unchanged repeat, modified/removed records, pending-to-posted aliasing with user fields preserved, checkpoint atomicity, and rollback before commit.
2. Add normalized provider dataclasses and a synthetic adapter.
3. Implement account/balance/transaction application inside one `BEGIN IMMEDIATE` transaction and advance the checkpoint only with the ledger mutation.
4. Add canonical alias resolution, provider-version audit hashes, tombstones, and sync-run accounting.
5. Run focused and full suites, then commit.

## Task 4: Add financial-integrity workflows

**Files:**
- Create: `tests/test_financial_integrity.py`
- Create: `src/fintracka/ledger.py`
- Create: `src/fintracka/imports.py`

1. Write failing tests for user edits, exact splits, ordered first-match rules, transfer candidates/confirmation, refunds/reimbursements/reversals, duplicate CSV detection, and reconciliation including a one-cent failure.
2. Implement category/rule, split, transfer, import, and reconciliation services over short transactions.
3. Append audit events for every user and rule mutation.
4. Run focused and full suites, then commit.

## Task 5: Add independent budgets and reports

**Files:**
- Create: `tests/test_budgets_reports.py`
- Create: `src/fintracka/budgets.py`
- Create: `src/fintracka/reports.py`

1. Write failing tests across month/year boundaries for tracking targets, envelope availability, transfer exclusion, refunds, account flags, and non-USD combined-total exclusion.
2. Implement tracking and envelope calculations as separate read models over the shared ledger.
3. Implement overview, cash-flow, spending, budget, and balance reports with stable filters/sorts.
4. Run focused and full suites, then commit.

## Task 6: Expose the secured localhost API and jobs

**Files:**
- Create: `tests/test_api.py`
- Create: `src/fintracka/api.py`
- Create: `src/fintracka/jobs.py`
- Create: `src/fintracka/security.py`

1. Write failing tests for health/bootstrap, HttpOnly SameSite session cookies, CSRF, strict Host/Origin checks, unexpected fields, optimistic conflicts, cursor pagination, and interrupted-job recovery.
2. Implement the `/api/v1` routes needed by every approved page using explicit Pydantic models.
3. Add one in-process worker, persisted job rows, and startup interruption repair.
4. Ensure API/log responses contain no secrets, raw provider payloads, descriptions, amounts, or account masks.
5. Run focused and full suites, then commit.

## Task 7: Add backups, spreadsheet exports, scheduling, and CLI

**Files:**
- Create: `tests/test_operations.py`
- Create: `src/fintracka/backups.py`
- Create: `src/fintracka/exports.py`
- Create: `src/fintracka/cli.py`
- Create: `src/fintracka/launchd.py`

1. Read the spreadsheet skill before implementing exports.
2. Write failing tests for verified SQLite backup/restore, retention, stable Excel sheets/IDs, update/deletion, stale-tail behavior, formula-injection escaping, interrupted export, and launchd output.
3. Implement the process lock, online backup API, atomic validated `.xlsx` export, Google client boundary with fake-tested bounded replacement, CLI commands, and launchd plist generation.
4. Run focused and full suites, then commit.

## Task 8: Add Plaid Sandbox and secret storage boundaries

**Files:**
- Create: `tests/test_plaid_adapter.py`
- Create: `src/fintracka/keychain.py`
- Create: `src/fintracka/plaid_adapter.py`

1. Write failing fake-client tests for transactions-only Link, completion, paginated sync, mutation restart, bounded retry, repair, revoke, and sanitized failures.
2. Implement the adapter without live credentials or network calls in tests.
3. Store only opaque Keychain references in SQLite; fail closed if Keychain support is unavailable.
4. Run focused/full suites and a sensitive-string scan, then commit.

## Task 9: Build the React dashboard

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/**`
- Create: `frontend/tests/**`
- Modify: `src/fintracka/api.py`

1. Implement the approved calm-instrument tokens, persistent shell, overview cash-movement strip, Accounts, Transactions, Tracking Budget, Envelope Budget, Reports, Rules, Connections, and Settings pages.
2. Add accessible loading/error/empty states, dense table behavior, split and connection dialogs, keyboard navigation, and stored dark mode.
3. Keep API state in small page-local hooks and avoid a general component framework.
4. Run TypeScript checks, unit tests, production build, and serve the build from FastAPI.
5. Commit the frontend.

## Task 10: Complete end-to-end and security verification

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/fintracka.spec.ts`
- Modify: `SECURITY_PLAN.md`
- Modify: `TEST_PLAN.md`
- Modify: `DEVELOPMENT_TOOLS.md`

1. Read the web-app testing skill before browser testing.
2. Add Playwright coverage for onboarding, synthetic dashboard, filters, bulk categorization, split, transfer confirmation, both budgets, rule preview, sync failure/repair, export, dark mode, and keyboard navigation.
3. Run Python, TypeScript, build, Playwright, migration/integrity, secret-scan, and dependency checks.
4. Perform a repository-grounded security review and update the threat model with implemented controls and residual risks.
5. Record the Python 3.14/FileVault/encrypted-backup/live-provider approval gates; do not create a live connection.
6. Use verification-before-completion, self-review the branch, and use finishing-a-development-branch for handoff.
