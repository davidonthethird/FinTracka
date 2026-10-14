# Planning Accuracy, Savings, and Subcategories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Planning mathematically honest and immediately readable, hide internal money movement from ordinary spending, add deterministic editable subcategories, and add a separate Savings workspace.

**Architecture:** Extend the existing SQLite ledger with one additive migration, then keep coverage math, subcategory assignment, and savings aggregation in focused services. Existing ledger-entry, audit, optimistic-conflict, ownership, export, and security patterns remain authoritative; React consumes typed API responses without reproducing financial calculations.

**Tech Stack:** Python 3.14, SQLite numbered migrations, FastAPI/Pydantic, React/TypeScript/Vite, Recharts, Pytest, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-planning-accuracy-savings-subcategories-design.md`

## Global Constraints

- Keep current Plaid Items and their approximately 90-day history; never revoke or reconnect them for this feature.
- SQLite remains authoritative and retains imported records indefinitely; no migration physically deletes financial history.
- All money remains integer USD minor units and all financial mutations remain audited and optimistic-lock protected.
- Transfers and card payments remain stored and auditable while hidden from ordinary transaction and planning views by default.
- Subcategory automation is deterministic and local; add no AI, cloud categorization, or new runtime dependency.
- Manual investments have user-entered valuations only; add no return projection or automatic growth.
- Preserve the existing uncommitted change in `tests/test_readiness.py`; do not stage, overwrite, or revert it.
- Back up and integrity-check the live database before migration; scan for secrets before any public push.

## Review Focus

- A current-month forecast on day one must not divide by zero; Task 2 tests a fixed first-of-month clock.
- Refund-only or negative category activity must not produce a nonsensical percentage or projection; Task 2 pins the neutral/refund result.
- No usable historical month must return a zero average plus explicit `0 of N months available`, not an exception; Task 2 covers it.
- Changing a parent category must never retain an incompatible subcategory; Tasks 3 and 4 exercise service and API behavior.
- A savings-account transfer that is not yet linked must still appear once as savings activity while remaining absent from spending; Task 5 covers category-based and confirmed-pair cases.

---

### Task 1: Additive Ledger Schema and Starter Taxonomy

**Files:**
- Create: `src/fintracka/migrations/009_planning_accuracy_savings_subcategories.sql`
- Modify: `src/fintracka/db.py`
- Test: `tests/test_foundation.py`

**Interfaces:**
- Produces: `provider_connections.history_available_from`, `accounts.include_savings`, `subcategories`, `transaction_subcategory_rules`, transaction subcategory fields, `manual_assets`.
- Consumes: existing UUIDv7, date/currency checks, audit tables, categories, transactions, and connection/account timestamps.

- [ ] **Step 1: Write failing migration tests**

Add `test_migration_009_adds_coverage_subcategories_and_manual_assets` asserting schema versions 1–9, foreign keys/checks, automatic `include_savings=1` for savings subtypes, non-savings default 0, inferred Plaid coverage boundary, and unchanged canonical transaction/category counts and IDs. Add constraint assertions that a subcategory belongs to a category, owners are David/Ariela/Shared, asset kinds are savings/investment/other, and negative asset values fail.

- [ ] **Step 2: Verify RED**

Run: `.venv/bin/pytest tests/test_foundation.py -q`  
Expected: FAIL because migration 009 and its tables/columns do not exist.

- [ ] **Step 3: Implement migration 009**

Add the exact fields and tables from the spec. Seed editable subcategories for every current expense parent. Include at minimum:

- Dining: Restaurants, Takeout & delivery, Coffee & bakeries, Bars, General.
- Fees & interest: Bank fees, Card interest, Late fees, Other fees.
- Housing: Rent or mortgage, Home maintenance, Furniture, Household services, General.
- Tzedaka: Synagogue & community, Torah & education, Direct assistance, Organizations, Other.
- Groceries: Supermarkets, Warehouse clubs, Specialty markets, Convenience stores, General.
- Shopping: Clothing, Home improvement, Household, Electronics, Gifts, Online shopping, Personal items, General.
- Taxes: Income tax, Property tax, Estimated tax, Other tax.
- Fun: Entertainment, Hobbies, Events, Games, Recreation, General.
- Transport: Fuel, Auto repairs, Parking, Tolls, Public transit, Rideshare, Registration, General.
- Travel: Flights, Hotels, Car rental, Travel dining, Activities, General.
- Utilities: Electric, Gas, Water, Internet, Mobile phone, Waste, General.
- Insurance: Auto, Home or renters, Health, Life, Other.
- Debt payments: Student loans, Personal loans, Other debt.
- Healthcare: Doctor, Dental, Pharmacy, Vision, Therapy, Medical supplies, General.
- Other: Education, Children & family, Personal care, Pets, Subscriptions, Cash withdrawal, General.

Seed at least 40 conservative normalized merchant patterns covering common home-improvement, clothing, grocery, pharmacy, subscription, rideshare, fuel, airline, hotel, and entertainment merchants. Seed detailed Plaid-category mappings separately from merchant matches so user rules can outrank both.

Set existing Plaid `history_available_from` to connection creation date minus 90 days, adjusted earlier by its earliest transaction. Leave manual/synthetic coverage null. Do not reset Plaid cursors.

- [ ] **Step 4: Verify GREEN**

Run: `.venv/bin/pytest tests/test_foundation.py -q`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fintracka/migrations/009_planning_accuracy_savings_subcategories.sql src/fintracka/db.py tests/test_foundation.py
git commit -m "feat: add savings and subcategory schema"
```

### Task 2: Coverage-Aware Averages, Forecasts, and Status

**Files:**
- Create: `src/fintracka/history.py`
- Modify: `src/fintracka/planning.py`
- Test: `tests/test_planning.py`

**Interfaces:**
- Produces: `HistoryCoverage`, `usable_history_months(connection, selected_month, requested_months, spending_owner=None)`, expanded `PlanningCategory`, expanded `PlanningSnapshot`.
- Consumes: Task 1 coverage boundary and existing `ledger_entries`, `month_bounds`, effective targets, owners, refunds, splits, and transfer exclusion.

- [ ] **Step 1: Write failing financial tests**

Add tests asserting: a 12-month request with only August–September fully covered averages over two; an empty September between nonempty August/October counts as zero; partial leading months are omitted; `0 of 12` is valid; zero target plus spending is `unplanned`; zero target and zero spending is `no_target`; refund-only activity has no percentage/projection; calendar pace is exact before six months; median historical pacing is used at six months; first-of-month clock is safe; past/future months do not forecast; and 90%/100% status boundaries match the spec.

- [ ] **Step 2: Verify RED**

Run: `.venv/bin/pytest tests/test_planning.py -q`  
Expected: FAIL on missing coverage and forecast fields.

- [ ] **Step 3: Implement the shared calculations**

Define immutable response dataclasses with exact minor-unit fields, nullable percentages/projections, requested/usable month metadata, and plain status enums. Inject `today: date | None = None` into `planning_snapshot` for deterministic tests. Use integer rounding helpers; never calculate money using float. Aggregate category projections to obtain the overall projection.

- [ ] **Step 4: Verify GREEN and report compatibility**

Run: `.venv/bin/pytest tests/test_planning.py tests/test_budgets_reports.py -q`  
Expected: PASS with unchanged non-planning report totals.

- [ ] **Step 5: Commit**

```bash
git add src/fintracka/history.py src/fintracka/planning.py tests/test_planning.py
git commit -m "feat: add honest averages and spending forecasts"
```

### Task 3: Deterministic Subcategory Service

**Files:**
- Create: `src/fintracka/subcategories.py`
- Modify: `src/fintracka/sync.py`
- Modify: `src/fintracka/ledger.py`
- Test: `tests/test_subcategories.py`
- Test: `tests/test_sync.py`

**Interfaces:**
- Produces: `list_subcategories`, `create_subcategory`, `assign_subcategory`, `reprocess_subcategory_rule`, `automatic_subcategory_id`; scope values remain `one_time`, `future`, `past_and_future`.
- Consumes: Task 1 taxonomy/rules, existing merchant normalization, transaction category ownership, withdrawal marker, audit events, and provider/user-field separation.

- [ ] **Step 1: Write failing service and sync tests**

Cover Lowe's → Shopping/Home improvement, Macy's → Shopping/Clothing, built-in Plaid-detail fallback, user merchant rule precedence, custom subcategory creation, one-time/future/past-and-future scopes, manual-choice preservation on sync, incompatible parent change clearing the child, idempotent reprocessing, undo/audit data, and guaranteed one-time withdrawal changes.

- [ ] **Step 2: Verify RED**

Run: `.venv/bin/pytest tests/test_subcategories.py tests/test_sync.py -q`  
Expected: FAIL because the subcategory service is absent.

- [ ] **Step 3: Implement minimal deterministic assignment**

Keep matching exact after existing normalization. User rules outrank built-in merchant rules, which outrank Plaid-detail mappings, which outrank `General`. Sync may update provider proposals but cannot overwrite a manual effective subcategory. Parent-category edits validate or clear the child in the same write transaction.

- [ ] **Step 4: Verify GREEN**

Run: `.venv/bin/pytest tests/test_subcategories.py tests/test_sync.py tests/test_financial_integrity.py -q`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fintracka/subcategories.py src/fintracka/sync.py src/fintracka/ledger.py tests/test_subcategories.py tests/test_sync.py
git commit -m "feat: add deterministic transaction subcategories"
```

### Task 4: Transaction and Planning API Expansion

**Files:**
- Modify: `src/fintracka/api.py`
- Modify: `src/fintracka/planning.py`
- Test: `tests/test_api.py`

**Interfaces:**
- Produces: `include_transfers: bool = False` transaction filter; subcategory response fields and mutation endpoints; expanded planning JSON; category-detail subcategory totals.
- Consumes: Tasks 2–3 dataclasses and service functions.

- [ ] **Step 1: Write failing API tests**

Assert transfer/card-payment rows are absent by default and present with `include_transfers=true`; search and cursor pagination honor the filter; planning serializes coverage, percentages, forecast and overall status; category detail totals subcategories; subcategory create/assign/reprocess reject unexpected fields and stale timestamps; invalid parent/child combinations return 422; hostile Origin/Host and missing CSRF remain rejected.

- [ ] **Step 2: Verify RED**

Run: `.venv/bin/pytest tests/test_api.py -q`  
Expected: FAIL on the new request/response contracts.

- [ ] **Step 3: Implement routes and Pydantic models**

Extend existing transaction queries rather than create a second register endpoint. Preserve stable sort/cursors. Reuse `_write_transaction`, `_require_revision`, session/CSRF middleware, and existing response sanitization.

- [ ] **Step 4: Verify GREEN**

Run: `.venv/bin/pytest tests/test_api.py -q`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fintracka/api.py src/fintracka/planning.py tests/test_api.py
git commit -m "feat: expose planning and subcategory controls"
```

### Task 5: Savings Service and API

**Files:**
- Create: `src/fintracka/savings.py`
- Modify: `src/fintracka/api.py`
- Modify: `src/fintracka/reports.py`
- Test: `tests/test_savings.py`
- Test: `tests/test_api.py`

**Interfaces:**
- Produces: `savings_summary(connection, month, owner=None) -> SavingsSummary`; manual asset create/update/deactivate operations; Savings endpoints and account inclusion flag.
- Consumes: Task 1 `include_savings`/`manual_assets`, account balances/history, effective owner, category-type transfer, confirmed links, and optimistic audit patterns.

- [ ] **Step 1: Write failing savings tests**

Cover connected savings balance/history, manual savings/investment/other assets, owner filters, nonnegative exact values, stale edits, deactivation, audit before/after values, combined net position, positive savings transfers as contributions, negative transfers as withdrawals, unpaired transfer-category activity included exactly once, confirmed pairs not duplicated, interest shown as activity but not Planning income, and ordinary savings-account purchases remaining expenses.

- [ ] **Step 2: Verify RED**

Run: `.venv/bin/pytest tests/test_savings.py tests/test_api.py -q`  
Expected: FAIL because Savings services and endpoints do not exist.

- [ ] **Step 3: Implement Savings aggregation and mutations**

Use the latest balance snapshot per included account. Keep connected accounts and manual assets distinct in the response. Add active manual asset values to net position exactly once. Derive contribution/withdrawal rows from savings-account transfer activity without changing general ledger categorization.

- [ ] **Step 4: Verify GREEN**

Run: `.venv/bin/pytest tests/test_savings.py tests/test_api.py tests/test_budgets_reports.py -q`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fintracka/savings.py src/fintracka/api.py src/fintracka/reports.py tests/test_savings.py tests/test_api.py
git commit -m "feat: add savings workspace backend"
```

### Task 6: Planning Status and Proportional Flow UI

**Files:**
- Modify: `frontend/src/planning/model.ts`
- Modify: `frontend/src/planning/model.test.ts`
- Modify: `frontend/src/planning/PlanningPage.tsx`
- Modify: `frontend/src/planning/PlanningFlow.tsx`
- Modify: `frontend/src/planning/CategoryDrawer.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/e2e/fintracka.spec.ts`

**Interfaces:**
- Produces: typed coverage/status/forecast rendering and proportional accessible category lanes.
- Consumes: Tasks 2 and 4 planning response exactly; performs no financial recomputation beyond display widths and formatting.

- [ ] **Step 1: Write failing model and browser tests**

Assert zero-target spending renders amber `unplanned`, coverage says `2 of 12 months available`, headline shows percentage left/over and projected outcome, 90%/over states use text plus color classes, lane allocation reflects target shares with a minimum size, drawer shows forecast/subcategories, and narrow/keyboard behavior remains usable.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix frontend test -- --run && npm --prefix frontend run test:e2e`  
Expected: FAIL on missing fields and UI.

- [ ] **Step 3: Implement the approved presentation**

Use existing tokens and components. The backend supplies labels and financial values; frontend helpers only format percentages and clamp proportional CSS weights. Preserve abortable requests, focus trapping/restoration, dark mode, and text equivalents.

- [ ] **Step 4: Verify GREEN**

Run: `npm --prefix frontend test -- --run && npm --prefix frontend run typecheck && npm --prefix frontend run build && npm --prefix frontend run test:e2e`  
Expected: PASS; the existing Vite chunk-size warning is permitted.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/planning frontend/src/styles.css frontend/e2e/fintracka.spec.ts
git commit -m "feat: clarify monthly planning status"
```

### Task 7: Transaction Subcategory and Transfer Controls

**Files:**
- Create: `frontend/src/transactions/SubcategoryEditor.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/e2e/fintracka.spec.ts`

**Interfaces:**
- Produces: hidden-transfer toggle, category/subcategory editing, inline custom creation, and three-scope learning UI.
- Consumes: Task 4 transaction and subcategory APIs.

- [ ] **Step 1: Write failing browser tests**

Assert transfer/payment rows are initially absent and recoverable by toggle; category selection narrows subcategories; Lowe's and Macy's arrive with expected automatic children; a custom child can be created and selected; one-time/future/past-and-future scopes persist; a parent change cannot display an incompatible child; withdrawal edits remain one-time.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix frontend run test:e2e`  
Expected: FAIL because these controls do not exist.

- [ ] **Step 3: Implement the compact editing flow**

Reuse the current transaction register and learning-scope control. Do not add another grid or general component library. Include subcategory in search/filter text and preserve pagination cancellation and stale-response protection.

- [ ] **Step 4: Verify GREEN**

Run: `npm --prefix frontend run typecheck && npm --prefix frontend run build && npm --prefix frontend run test:e2e`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/transactions/SubcategoryEditor.tsx frontend/src/App.tsx frontend/src/styles.css frontend/e2e/fintracka.spec.ts
git commit -m "feat: add editable transaction subcategories"
```

### Task 8: Savings UI

**Files:**
- Create: `frontend/src/savings/SavingsPage.tsx`
- Create: `frontend/src/savings/ManualAssetDialog.tsx`
- Create: `frontend/src/savings/model.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/e2e/fintracka.spec.ts`

**Interfaces:**
- Produces: `/savings` primary navigation page with balances, totals, activity, owner filtering, and manual asset lifecycle.
- Consumes: Task 5 Savings API; does not feed Planning state.

- [ ] **Step 1: Write failing browser tests**

Assert Savings navigation exists; connected savings and manual assets are visually distinct; cash savings/investment/other/combined totals are exact; contributions and withdrawals render without appearing in Planning; owner filtering works; manual asset create/edit/deactivate persists; valuation dates and empty/error states are accessible.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix frontend run test:e2e`  
Expected: FAIL because `/savings` is absent.

- [ ] **Step 3: Implement Savings page and dialog**

Use existing metric lines, instrument panels, chart library, form validation, and focus behavior. Do not add goals, returns, projections, or investment-provider connectivity.

- [ ] **Step 4: Verify GREEN**

Run: `npm --prefix frontend run typecheck && npm --prefix frontend run build && npm --prefix frontend run test:e2e`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/savings frontend/src/App.tsx frontend/src/styles.css frontend/e2e/fintracka.spec.ts
git commit -m "feat: add household savings workspace"
```

### Task 9: Exports, Live Migration, and Release Verification

**Files:**
- Modify: `src/fintracka/exports.py`
- Modify if required by failures: files owned by Tasks 1–8 only
- Test: `tests/test_operations.py`
- Verify: `docs/superpowers/specs/2026-10-13-planning-accuracy-savings-subcategories-design.md`

**Interfaces:**
- Produces: deterministic exported subcategories/manual assets, migrated live ledger, rebuilt Desktop app, and merge-ready commits.
- Consumes: all earlier tasks.

- [ ] **Step 1: Write failing export tests**

Assert Transactions includes stable parent/subcategory IDs and names; manual assets export deterministically with owner/kind/value/as-of date; repeated exports remain identical; edits/deactivation remove stale rows; every user-written category/subcategory/asset value receives formula-injection escaping.

- [ ] **Step 2: Implement and verify exports**

Run: `.venv/bin/pytest tests/test_operations.py -q`  
Expected: PASS after extending the existing snapshot builder; no new workbook engine.

- [ ] **Step 3: Run the full synthetic milestone**

Run: `.venv/bin/pytest -q && npm --prefix frontend test -- --run && npm --prefix frontend run typecheck && npm --prefix frontend run build && npm --prefix frontend run test:e2e && .venv/bin/pip-audit && npm --prefix frontend audit --audit-level=high && git diff --check`  
Expected: all pass; only the known Vite chunk warning, Starlette/httpx warning, and local-package pip-audit skip are permitted.

- [ ] **Step 4: Security and artifact scan**

Scan tracked files, current diff, Git history, SQLite, logs, frontend build, screenshots, and browser storage for Plaid/Google credentials, access tokens, financial database artifacts, and raw OAuth/provider payloads. Compare exact Keychain values without printing them. Expected: zero secret matches and no tracked sensitive artifacts.

- [ ] **Step 5: Back up, migrate, and verify live data**

Stop the local server; create a SQLite online backup in the existing backup directory; require mode 0600 and `PRAGMA integrity_check = ok`; restore into `mktemp -d`; record non-secret counts and report totals. Apply migration 009 once, then assert versions 1–9, stable transaction/account/category/rule IDs and counts, expected additive seed rows, inferred coverage, unchanged report totals except intentionally hidden register rows/manual assets, completed Planning/Savings snapshots, and zero secrets in SQLite.

- [ ] **Step 6: Rebuild and smoke-test the Desktop launcher**

Launch `/Users/david/Desktop/FinTracka.command` in Chrome. Verify Overview, Transactions default/transfer toggle, Planning status and category drawer, Savings, dark mode, and persistence after one server restart. Do not create or alter a live Plaid Item.

- [ ] **Step 7: Commit verification-owned changes**

```bash
git add src/fintracka/exports.py tests/test_operations.py
git commit -m "feat: export savings and subcategories"
```

Do not create an empty commit when no verification-owned change remains.

- [ ] **Step 8: Push safely**

Push `feature/live-integrations` to the configured public GitHub remote only after the zero-secret scan. Use Terminal Git, not browser GitHub. If authentication or DNS fails, preserve local commits and report the non-secret blocker.
