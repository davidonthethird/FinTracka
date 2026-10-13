# Planning Flow and Manual Cash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tracking Budget with an interactive goal-versus-actual planning flow, add recurring planned income and targets, make Tzedaka at least 10% of planned Salary, and add audited manual cash transactions.

**Architecture:** Keep actual money in the canonical transaction ledger and store plans in separate effective-dated tables. A focused planning service resolves versions, overrides, averages, actuals, and Tzedaka minimums; FastAPI exposes strict mutations; React renders the flow and detail drawer. Manual cash uses an internal app-owned connection/account so it participates in ledger reports without impersonating a bank balance.

**Tech Stack:** Python 3.14, SQLite numbered migrations, FastAPI/Pydantic, React 19/TypeScript, Recharts, Pytest, Vitest, Playwright, OpenPyXL.

**Spec:** `docs/superpowers/specs/2026-10-13-planning-flow-manual-cash-design.md`

## Global Constraints

- SQLite remains authoritative; all money is integer minor units and release-1 planning totals are USD only.
- Planned income never creates ledger transactions or changes balances.
- Manual cash is a real audited expense but has no observed balance and is excluded from net position.
- Existing Giving identity, assignments, rules, and history must survive its rename to Tzedaka.
- Tzedaka target is never below `ceil(effective planned Salary / 10)`; Custom income is excluded.
- Historical averages use 1–12 completed months, include zero months, net refunds, and exclude transfers, pending, and tombstoned records.
- Everyone/David/Ariela/Shared filters affect averages, actuals, trends, and drill-downs, not household targets.
- Envelope Budget remains independent.
- Mutations require session, CSRF, Host/Origin checks, strict fields, optimistic conflicts where records are edited, and audit events.
- No real financial data or credentials may enter fixtures, logs, screenshots, Git, or CI.

## Review Focus

- A planning month before a source's first version or after deactivation must omit that source without leaking a later value; Task 2 pins both cases.
- A Salary month override that produces a fractional-cent 10% minimum must round upward and supersede a lower target; Task 2 pins this calculation.
- An average window containing no transactions must return zero for every included category without division errors; Task 2 pins the full-zero window.
- A manual-cash mutation against a Plaid transaction ID must fail without changing or tombstoning the provider record; Task 3 pins ownership enforcement.
- Conservative withdrawal fallback matching must not mark an ordinary merchant description containing the word `cash`; Task 3 pins positive and negative detection examples.

---

### Task 1: Schema, Tzedaka Migration, and Internal Cash Source

**Files:**
- Create: `src/fintracka/migrations/008_planning_and_manual_cash.sql`
- Modify: `tests/test_foundation.py`
- Modify: `tests/conftest.py`

**Interfaces:**
- Produces: planning tables `planning_income_sources`, `planning_income_versions`, `planning_income_overrides`, `planning_target_versions`, and `planning_target_overrides`; transaction flag `is_cash_withdrawal`; stable manual connection/account rows.
- Produces: the existing Giving category ID renamed to Tzedaka and assigned to a standalone Tzedaka group.
- Consumes: migration registry and UUIDv7/check conventions from migrations 001–007.

- [ ] **Step 1: Write failing migration tests**

Add tests asserting migration versions are `[1,2,3,4,5,6,7,8]`; Tzedaka exists in group Tzedaka under the former Giving ID; no Giving category remains; the internal `manual` connection and Manual cash account exist with `include_overview=1`, `include_budget=1`, `include_net=0`, and `include_export=1`; and every new check constraint rejects an invalid month, income type, negative amount, or invalid withdrawal flag.

- [ ] **Step 2: Write a failing legacy-upgrade test**

Create a database migrated only through 007, attach one transaction and one categorization rule to Giving, apply migration 008, and assert both foreign keys still resolve to the same ID now named Tzedaka. Insert one `tracking_budget_targets` row before upgrade and assert it becomes a `planning_target_overrides` row with the same category, month, amount, and currency.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `.venv/bin/pytest tests/test_foundation.py -q`

Expected: FAIL because migration 008 and its tables do not exist.

- [ ] **Step 4: Implement migration 008**

Use fixed valid UUIDv7 identifiers for the new group, institution, connection, and account. Preserve Giving's category ID with `UPDATE`; migrate tracking targets with `INSERT ... SELECT`; add exact enum, date, amount, currency, unique-key, and foreign-key checks. Do not drop `tracking_budget_targets` yet; stop reading/writing it in later tasks.

- [ ] **Step 5: Run migration tests**

Run: `.venv/bin/pytest tests/test_foundation.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fintracka/migrations/008_planning_and_manual_cash.sql tests/test_foundation.py tests/conftest.py
git commit -m "feat: add planning and manual cash schema"
```

### Task 2: Planning Domain Service

**Files:**
- Create: `src/fintracka/planning.py`
- Create: `tests/test_planning.py`
- Modify: `src/fintracka/budgets.py`

**Interfaces:**
- Produces: `create_income_source(connection, title, income_type, amount_minor, effective_month) -> str`.
- Produces: `set_income_version(connection, source_id, title, income_type, amount_minor, effective_month, active) -> None` and `set_income_override(connection, source_id, month, amount_minor | None) -> None`.
- Produces: `set_recurring_target(connection, category_id, amount_minor, effective_month) -> None` and `set_target_override(connection, category_id, month, amount_minor | None) -> None`.
- Produces: `planning_snapshot(connection, month, average_months, spending_owner=None) -> PlanningSnapshot` with income sources, totals, category rows, trend points, contributing IDs, and surplus/shortfall.
- Consumes: `ledger_entries(...)` and `month_bounds(...)` from `reports.py`; Task 1 tables.

- [ ] **Step 1: Write failing tests for effective-dated income**

Test a Salary source at `$5,900`, a Custom source at `$1,100`, a later Salary version, a one-month override, and deactivation. Assert each selected month resolves only the latest version on or before that month; months before creation and after deactivation omit the source; prior months never change.

- [ ] **Step 2: Write failing tests for targets and Tzedaka**

Assert recurring targets flow forward, month overrides win once, and earlier values remain fixed. Assert planned Salary `10_001` cents creates a Tzedaka minimum of `1_001`, Custom income does not affect it, a higher explicit target wins, and lower target mutations raise `PlanningError` with `minimum_minor=1_001`.

- [ ] **Step 3: Write failing tests for averages and filters**

Across a 3-month window, assert the denominator remains 3 when one or all months have no activity; refunds reduce expense activity; confirmed transfers, pending, and tombstoned transactions are excluded; manual cash is included; and Everyone/David/Ariela/Shared results select effective spending ownership. Include split transaction activity.

- [ ] **Step 4: Run planning tests and verify failure**

Run: `.venv/bin/pytest tests/test_planning.py -q`

Expected: FAIL because `fintracka.planning` does not exist.

- [ ] **Step 5: Implement the planning service**

Define immutable dataclasses `PlanningIncome`, `PlanningCategory`, `PlanningTrendPoint`, and `PlanningSnapshot`. Validate `YYYY-MM`, owner, 1–12 window, nonnegative amounts, income type, and active expense categories at the service boundary. Resolve versions with latest-effective correlated queries and calculate category activity in one ledger pass per requested window, including zero months explicitly.

- [ ] **Step 6: Redirect legacy Tracking Budget reads/writes**

Keep `tracking_budget(...)` and `set_tracking_target(...)` callable for compatibility, but implement them through the planning target service so existing report callers no longer read `tracking_budget_targets`. Leave Envelope Budget untouched.

- [ ] **Step 7: Run focused domain tests**

Run: `.venv/bin/pytest tests/test_planning.py tests/test_budgets_reports.py -q`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/fintracka/planning.py src/fintracka/budgets.py tests/test_planning.py
git commit -m "feat: add effective monthly planning engine"
```

### Task 3: Manual Cash and Withdrawal-Safe Categorization

**Files:**
- Create: `src/fintracka/manual_cash.py`
- Create: `tests/test_manual_cash.py`
- Modify: `src/fintracka/providers.py`
- Modify: `src/fintracka/plaid_adapter.py`
- Modify: `src/fintracka/sync.py`
- Modify: `src/fintracka/ledger.py`
- Modify: `src/fintracka/reports.py`
- Modify: `tests/test_plaid_adapter.py`
- Modify: `tests/test_sync.py`
- Modify: `tests/test_financial_integrity.py`
- Modify: `tests/test_budgets_reports.py`

**Interfaces:**
- Produces: `create_manual_cash(connection, title, amount_minor, category_id, local_date, spending_owner) -> str`.
- Produces: `update_manual_cash(connection, transaction_id, expected_updated_at, title, amount_minor, category_id, local_date, spending_owner) -> None`.
- Produces: `delete_manual_cash(connection, transaction_id, expected_updated_at) -> None`.
- Produces: `NormalizedTransaction.is_cash_withdrawal: bool` and persisted `transactions.is_cash_withdrawal`.
- Consumes: Task 1 internal Manual cash account and existing transaction/audit conventions.

- [ ] **Step 1: Write failing manual-cash lifecycle tests**

Create an entry with title, positive input amount, category, default date, and Shared owner; assert the ledger stores a negative amount and reports/ownership totals include it. Edit every user field and assert an audit event. Delete it and assert tombstoning removes it from normal reports while retaining the row and audit history. Assert edits/deletes against a Plaid-owned transaction raise `ManualCashError` and leave it byte-for-byte unchanged.

- [ ] **Step 2: Write failing withdrawal tests**

Assert Plaid personal-finance detail `CASH_ADVANCE` or `CASH_WITHDRAWAL` marks a transaction as a withdrawal and defaults an otherwise uncategorized withdrawal to Other. Assert conservative exact/token fallback descriptions such as `ATM WITHDRAWAL 1234` match, while `CASH & CARRY MARKET` and `CASHBACK REWARD` do not. Assert withdrawal category changes force `one_time`, affect one row, and create/update no learned rule.

- [ ] **Step 3: Write a failing Overview separation test**

Assert manual cash increases total spending and a new `off_bank_cash_spending_minor` field, but does not change observed cash balances, opening cash, card liabilities, or net position.

- [ ] **Step 4: Run focused tests and verify failure**

Run: `.venv/bin/pytest tests/test_manual_cash.py tests/test_plaid_adapter.py tests/test_sync.py tests/test_financial_integrity.py tests/test_budgets_reports.py -q`

Expected: FAIL on missing manual-cash service and withdrawal flag.

- [ ] **Step 5: Implement manual-cash CRUD**

Use the stable internal account, exact cents, a negative stored amount, `category_source='manual'`, `pending=0`, and audit actions `manual_cash_create`, `manual_cash_update`, and `manual_cash_delete`. Only transactions joined to provider `manual` may use update/delete operations; deletion sets `tombstoned=1`.

- [ ] **Step 6: Implement withdrawal normalization and categorization guard**

Add the boolean field through Plaid normalization and sync upsert without overwriting user fields. Map a detected, otherwise uncategorized withdrawal to Other. Update `categorize_transaction(...)` so any flagged withdrawal internally uses `one_time`, even when the caller requested another scope. Extend `Overview` with `off_bank_cash_spending_minor` while keeping observed balance calculations limited to accounts with snapshots.

- [ ] **Step 7: Run focused tests**

Run: `.venv/bin/pytest tests/test_manual_cash.py tests/test_plaid_adapter.py tests/test_sync.py tests/test_financial_integrity.py tests/test_budgets_reports.py -q`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/fintracka/manual_cash.py src/fintracka/providers.py src/fintracka/plaid_adapter.py src/fintracka/sync.py src/fintracka/ledger.py src/fintracka/reports.py tests/test_manual_cash.py tests/test_plaid_adapter.py tests/test_sync.py tests/test_financial_integrity.py tests/test_budgets_reports.py
git commit -m "feat: add manual cash and withdrawal safeguards"
```

### Task 4: Planning and Manual Cash API

**Files:**
- Modify: `src/fintracka/api.py`
- Modify: `tests/test_api.py`

**Interfaces:**
- Produces: `GET /api/v1/planning/{month}?average_months=1..12&spending_owner=David|Ariela|Shared`.
- Produces: `POST /api/v1/planning/income-sources`, `PATCH /api/v1/planning/income-sources/{id}`, `PUT /api/v1/planning/income-sources/{id}/overrides/{month}`.
- Produces: `PUT /api/v1/planning/targets/{category_id}` and `PUT /api/v1/planning/targets/{category_id}/overrides/{month}`.
- Produces: `POST /api/v1/transactions/manual-cash`, `PATCH /api/v1/transactions/manual-cash/{id}`, and `DELETE /api/v1/transactions/{id}`.
- Consumes: Task 2 planning service and Task 3 manual-cash service.

- [ ] **Step 1: Write failing API contract tests**

Assert the planning response includes income totals, Salary subtotal, Tzedaka minimum, category average/target/actual/remaining/status, trends, contributing IDs, and surplus/shortfall. Assert all mutations return sanitized records and require the normal cookie and CSRF token.

- [ ] **Step 2: Write failing validation and conflict tests**

Assert invalid month, `average_months` 0 or 13, invalid owner/type, negative/overflow amount, unexpected JSON field, stale `expected_updated_at`, and below-minimum Tzedaka target return 4xx without partial writes. Assert below-minimum response exposes only `minimum_minor`, not internal SQL.

- [ ] **Step 3: Write failing manual-cash API tests**

Assert omitted date/owner default to today/Shared; title, amount, and category are required; creation appears in `/transactions`; edit updates the row; delete tombstones it; and delete against a provider transaction returns 403. Assert withdrawal responses expose `is_cash_withdrawal` and categorization reports one affected row.

- [ ] **Step 4: Run the API tests and verify failure**

Run: `.venv/bin/pytest tests/test_api.py -q`

Expected: FAIL on missing routes and response fields.

- [ ] **Step 5: Implement strict Pydantic models and routes**

Use existing `_write_transaction`, request security middleware, response-model patterns, and optimistic timestamp comparison. Convert service exceptions to stable 404/409/422 responses. Include `manual_cash` and `is_cash_withdrawal` in transaction responses without exposing provider payloads.

- [ ] **Step 6: Run API and security regression tests**

Run: `.venv/bin/pytest tests/test_api.py tests/test_security.py -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/fintracka/api.py tests/test_api.py
git commit -m "feat: expose planning and manual cash APIs"
```

### Task 5: Planning Flow and Cash Entry Interface

**Files:**
- Create: `frontend/src/planning/PlanningPage.tsx`
- Create: `frontend/src/planning/PlanningFlow.tsx`
- Create: `frontend/src/planning/CategoryDrawer.tsx`
- Create: `frontend/src/planning/model.ts`
- Create: `frontend/src/planning/model.test.ts`
- Create: `frontend/src/transactions/ManualCashDialog.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/e2e/fintracka.spec.ts`

**Interfaces:**
- Produces: Planning route replacing Tracking Budget; planned-income editor; 1–12 month slider; owner filter; average/target/actual flow; category drawer; Add cash spending dialog.
- Consumes: Task 4 JSON contracts and existing `api`, `formatMoney`, month control, focus, and theme patterns.

- [ ] **Step 1: Write failing planning view-model tests**

Test pure helpers that build the exact month/window/owner query, validate slider values 1–12, derive remaining/overspent text, scale zero and nonzero flow bands, enforce the displayed Tzedaka minimum, and preserve a stable all-zero view model. Keep Vitest in its current Node environment; do not add a DOM test dependency.

- [ ] **Step 2: Extend the failing Playwright workflow**

Assert planned sources and Salary/Custom labels render; changing month/window/owner requests new data; selecting a category opens a drawer with matching-window trend and current-month transactions; Escape closes and returns focus; recurring versus one-month target saves call distinct endpoints; Tzedaka cannot submit below the displayed minimum; and Add cash requires title/amount/category and defaults today/Shared.

- [ ] **Step 3: Run frontend tests and verify failure**

Run: `npm --prefix frontend test -- --run`

Expected: FAIL because planning components do not exist.

- [ ] **Step 4: Implement Planning page and flow**

Use semantic HTML/CSS and lightweight SVG/HTML flow bands; do not add a new visualization dependency. Render subdued average, primary target, and filled actual with exact text labels and non-color status. Preserve household-target labeling when a spender filter is active. Stack income → plan → categories below the desktop breakpoint.

- [ ] **Step 5: Implement the category drawer and manual-cash dialogs**

Use existing dialog patterns, add focus trap/restore and Escape handling, and preselect Tzedaka from its quick action. Manual transaction rows receive Manual cash, Edit, and Delete controls; withdrawal rows state that category changes are one-time and hide future/retroactive scopes. Update Overview to label `off_bank_cash_spending_minor` separately from observed bank-balance movement.

- [ ] **Step 6: Add the end-to-end workflow**

Extend the synthetic browser test to create Salary and Custom sources, verify the Tzedaka minimum, change average window and owner, set a target, inspect a category trend, create/edit/delete cash spending, and prove a withdrawal edit offers only one-time behavior.

- [ ] **Step 7: Run frontend verification**

Run: `npm --prefix frontend test -- --run && npm --prefix frontend run typecheck && npm --prefix frontend run build && npm --prefix frontend run test:e2e`

Expected: all commands PASS; Vite's existing chunk-size warning is permitted.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/planning frontend/src/transactions/ManualCashDialog.tsx frontend/src/App.tsx frontend/src/styles.css frontend/e2e/fintracka.spec.ts
git commit -m "feat: add household planning flow"
```

### Task 6: Deterministic Planning Exports

**Files:**
- Modify: `src/fintracka/exports.py`
- Modify: `tests/test_operations.py`

**Interfaces:**
- Produces: Monthly Budget and Yearly Budget snapshots sourced from the planning service; planned-income and planning metadata rows; manual cash identification in Transactions.
- Consumes: Task 2 planning service and Task 3 manual transaction marker.

- [ ] **Step 1: Write failing export tests**

Assert Excel/Google snapshots add a Planned Income sheet and update Monthly Budget with effective planned income, Salary/Custom type, target, actual, `average_window_months=12`, remaining, and Tzedaka minimum for every month of the current calendar year. Assert Yearly Budget aggregates those 12 monthly rows. Assert manual cash appears once and is labeled. Assert repeat export is identical and formula-like titles remain escaped.

- [ ] **Step 2: Run focused export tests and verify failure**

Run: `.venv/bin/pytest tests/test_operations.py -q`

Expected: FAIL because exports still read `tracking_budget_targets` and omit planning/manual fields.

- [ ] **Step 3: Implement deterministic export rows**

Replace legacy budget SQL with 12-month-window planning snapshots for January through December of the export year, preserve stable IDs and sorting, and add the Planned Income sheet plus planning metadata without changing authoritative spreadsheet behavior. Continue bounded writes and stale-tail clearing.

- [ ] **Step 4: Run export tests**

Run: `.venv/bin/pytest tests/test_operations.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fintracka/exports.py tests/test_operations.py
git commit -m "feat: export planning and manual cash data"
```

### Task 7: Full Verification and Safe Live Migration

**Files:**
- Modify if required by failures: files already listed in Tasks 1–6 only.
- Verify: `docs/superpowers/specs/2026-10-13-planning-flow-manual-cash-design.md` acceptance criteria.

**Interfaces:**
- Produces: migrated live ledger, rebuilt frontend, verified Desktop launcher, and merge-ready commits.
- Consumes: all previous tasks.

- [ ] **Step 1: Run the complete synthetic verification milestone**

Run: `.venv/bin/pytest -q && npm --prefix frontend test -- --run && npm --prefix frontend run typecheck && npm --prefix frontend run build && npm --prefix frontend run test:e2e && .venv/bin/pip-audit && npm --prefix frontend audit --audit-level=high && git diff --check`

Expected: all checks PASS; only the known Vite chunk-size warning and local-package pip-audit skip are permitted.

- [ ] **Step 2: Scan for secrets before touching the live ledger**

Scan the current diff and Git history for Plaid tokens, Google client secrets, private keys, database files, logs, screenshots, and OAuth payloads. Report counts/status only; never print a matched secret. Expected: no sensitive values or artifacts.

- [ ] **Step 3: Back up and verify the live database**

Stop the running server, run `fintracka backup` into the existing local backup directory, verify the new file with `PRAGMA integrity_check`, record provider transaction/category/rule counts, and perform a restore drill into a `mktemp -d` directory.

- [ ] **Step 4: Apply migration 008 and verify invariants**

Run the migration once against the live data. Assert SQLite integrity is `ok`; provider transaction/category/rule counts are unchanged except Giving is now Tzedaka under the same ID; schema versions are 1–8; no secrets entered SQLite; and planning snapshot calculations complete for the current month.

- [ ] **Step 5: Rebuild and test the Desktop launcher in Chrome**

Launch `/Users/david/Desktop/FinTracka.command`; confirm it rebuilds the frontend, starts on `127.0.0.1:8787`, exchanges a fresh bootstrap token in Chrome, loads Planning, and can create then delete a harmless test manual-cash entry without affecting provider records. Remove the test entry through the UI so its tombstone/audit trail proves deletion behavior.

- [ ] **Step 6: Final commit for any verification-only fixes**

If verification required changes, rerun the owning focused test before committing. Otherwise do not create an empty commit.

- [ ] **Step 7: Push without secrets**

Push `feature/live-integrations` to the configured public GitHub remote. If DNS/authentication fails, leave all commits local and report the exact non-secret blocker; do not switch to browser-based GitHub access.
