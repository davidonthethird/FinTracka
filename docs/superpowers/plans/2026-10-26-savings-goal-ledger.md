# Savings Goal Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an audited savings-goal ledger that divides real household savings into monthly-funded Regular Savings and Retirement goals, reconciles category overspending and withdrawals exactly once, and presents the result through an interactive Savings dashboard.

**Architecture:** Keep the existing account/transaction ledger authoritative and add an append-only virtual savings subledger in SQLite. A focused `savings_goals.py` domain module owns initialization, goal management, allocation, reconciliation, reviews, and history; the existing `savings.py` continues to own account/manual-asset summaries. FastAPI exposes strict mutation boundaries, and React uses existing Recharts plus pinned Lucide icons.

**Tech Stack:** Python 3.14, SQLite, FastAPI/Pydantic, React 19, TypeScript 7, Recharts 3.10.1, `lucide-react` 1.61.0, Vitest, Playwright, pytest.

**Spec:** `docs/superpowers/specs/2026-10-26-savings-goal-ledger-design.md`

## Global Constraints

- USD only; all financial values are integer minor units and allocation percentages are integer basis points.
- SQLite remains authoritative; savings history is append-only and corrections use reversing events.
- Existing connected accounts, manual assets, transactions, balance history, and audit history must remain intact.
- Regular Savings and Retirement are separate funding pools; Pershing receives no provider-specific code.
- No virtual goal history is created before the activation month.
- Every mutation keeps session-cookie, CSRF, strict Host/Origin, unexpected-field rejection, audit, and optimistic-conflict protections.
- Automatic withdrawal matching is exact amount, same pool, one candidate, and within seven calendar days; ambiguous, partial, or aggregate cases stay manual.
- A Planning category can link to at most one active savings goal.
- Run a verified local database backup before migration 014 or the first live initialization.

## Review Focus

- A provider modifies or removes a previously allocated transaction: append exact reversal/delta events without duplicates (`Task 4`).
- Locked sliders and indivisible cents: targets and basis points still total exactly with deterministic remainders (`Task 3`).
- Balance snapshots lag transaction activity: show a reconciliation warning and never invent a balancing event (`Task 5`).
- A settled spending draw later shrinks after recategorization: restore the goal and expose the now-unassigned withdrawal without changing the bank total (`Task 4`).
- Multiple similar withdrawals or deposits appear in the match window: refuse automatic matching and require explicit assignment (`Task 4`).

---

### Task 1: Numbered schema and pre-migration protection

**Files:**
- Create: `src/fintracka/migrations/014_savings_goal_ledger.sql`
- Modify: `src/fintracka/db.py`
- Modify: `tests/test_foundation.py`
- Test: `tests/test_savings_goals.py`

**Interfaces:**
- Produces tables `savings_settings`, `savings_goals`, `savings_goal_target_versions`, `savings_ledger_entries`, and `savings_month_reviews`.
- Produces nullable `accounts.savings_pool` and `manual_assets.savings_pool`, constrained to `regular`, `retirement`, or `NULL`.
- `savings_ledger_entries.source_key` plus event type provides idempotency; movement IDs pair bucket-to-bucket events.

- [ ] **Step 1: Write failing migration tests**

Add `test_migration_014_preserves_existing_savings_data_and_adds_goal_constraints` asserting existing accounts/assets remain unchanged, invalid pools/owners/colors/icons/currencies are rejected, source/event identifiers are constrained, and a second `migrate()` is a no-op.

- [ ] **Step 2: Verify the test fails**

Run: `.venv/bin/pytest tests/test_foundation.py::test_migration_014_preserves_existing_savings_data_and_adds_goal_constraints -v`

Expected: FAIL because migration 014 and its columns/tables do not exist.

- [ ] **Step 3: Add migration 014**

Define one-level goal hierarchy, effective-month target versions, append-only signed ledger entries, explicit pool assignments, review states (`pending`, `waiting`, `added`, `ignored`), unique active Planning-category links, indexes for month/source/goal queries, and foreign keys with restrictive deletes.

- [ ] **Step 4: Generalize the migration backup hook**

Change `migrate(connection)` so migrations 013 and 014 both create `fintracka-pre-migration-<version>-<timestamp>.sqlite3` backups before applying live-file schema changes.

- [ ] **Step 5: Run migration tests**

Run: `.venv/bin/pytest tests/test_foundation.py tests/test_savings.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fintracka/migrations/014_savings_goal_ledger.sql src/fintracka/db.py tests/test_foundation.py tests/test_savings_goals.py
git commit -m "feat: add savings goal ledger schema"
```

### Task 2: Goal initialization and audited goal management

**Files:**
- Create: `src/fintracka/savings_goals.py`
- Modify: `src/fintracka/savings.py`
- Test: `tests/test_savings_goals.py`

**Interfaces:**
- Produces `initialization_preview(connection, activation_month: str) -> SavingsInitializationPreview`.
- Produces `initialize_goal_ledger(connection, activation_month: str, expected_regular_balance_minor: int) -> None`.
- Produces `create_savings_goal(...) -> str`, `update_savings_goal(...) -> None`, `archive_savings_goal(...) -> None`, and `delete_unused_savings_goal(...) -> None`.
- Produces `assign_account_pool(...)` and `assign_manual_asset_pool(...)` with optimistic revisions.

- [ ] **Step 1: Write failing initialization tests**

Add tests asserting regular balances of `$20,000`, `$25,000`, and `$30,000` initialize as Emergency/General `$20,000/$0`, `$25,000/$0`, and `$25,000/$5,000`; repeat initialization adds no rows; retirement assets stay outside regular savings; and no pre-activation events exist.

- [ ] **Step 2: Verify initialization tests fail**

Run: `.venv/bin/pytest tests/test_savings_goals.py -k initialization -v`

Expected: FAIL because initialization interfaces do not exist.

- [ ] **Step 3: Implement preview and initialization**

Create built-in Regular Savings and Retirement groups, Shared Emergency and General Savings goals, opening ledger entries, explicit account/asset pool assignments, and one settings row. Reject a stale expected balance rather than initializing from a changed snapshot.

- [ ] **Step 4: Write failing goal lifecycle tests**

Cover name/owner/icon/color validation, one-level nesting, duplicate active Planning-category links, optimistic conflict, archive-with-history, delete-only-when-unused, reorder, and audit records.

- [ ] **Step 5: Implement the minimal goal lifecycle functions**

Use existing `new_id()`, UTC timestamp, transaction ownership, and `audit_events` conventions. Keep icon/color values in controlled Python allowlists shared by validation and API serialization.

- [ ] **Step 6: Run goal tests**

Run: `.venv/bin/pytest tests/test_savings_goals.py -k 'initialization or goal' -v`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/fintracka/savings.py src/fintracka/savings_goals.py tests/test_savings_goals.py
git commit -m "feat: initialize and manage savings goals"
```

### Task 3: Exact monthly allocation engine

**Files:**
- Modify: `src/fintracka/savings_goals.py`
- Test: `tests/test_savings_goals.py`

**Interfaces:**
- Produces `set_allocation_plan(connection, pool: str, effective_month: str, rows: Sequence[AllocationPlanRow], expected_updated_at: str) -> None`.
- Produces `allocation_preview(connection, pool: str, month: str, contribution_minor: int) -> AllocationPreview`.
- Produces `allocate_contribution(connection, transaction_id: str) -> None` and `reverse_source_events(connection, source_key: str, reason: str) -> None`.
- `AllocationPlanRow` contains `goal_id`, `monthly_target_minor`, `locked`, and `priority`.

- [ ] **Step 1: Write failing allocation tests**

Assert targets `$500/$400/$100` allocate an `$800` deposit as `$500/$300/$0`; allocate `$1,100` as `$550/$440/$110`; no-target deposits remain Unallocated; replay is idempotent; and removal appends exact reversals.

- [ ] **Step 2: Add rounding and lock tests**

Assert basis points total `10_000`, target cents total exactly, deterministic final-cent assignment, locked rows remain unchanged, editing a locked row unlocks it plus the lowest-priority other row, and Lock All stays stable until an edit.

- [ ] **Step 3: Verify allocation tests fail**

Run: `.venv/bin/pytest tests/test_savings_goals.py -k 'allocation or locked or remainder' -v`

Expected: FAIL because the allocation engine does not exist.

- [ ] **Step 4: Implement plan editing and deposit allocation**

Use integer arithmetic only. Direct dollar edits change only the edited target; percentage edits keep the pool total fixed and redistribute across unlocked rows. Contributions fill monthly targets by priority, then distribute excess across every active goal by derived percentages even when a goal is ahead of plan.

- [ ] **Step 5: Run allocation tests**

Run: `.venv/bin/pytest tests/test_savings_goals.py -k 'allocation or locked or remainder' -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fintracka/savings_goals.py tests/test_savings_goals.py
git commit -m "feat: allocate monthly savings exactly"
```

### Task 4: Spending draws and savings-withdrawal settlement

**Files:**
- Modify: `src/fintracka/savings_goals.py`
- Modify: `src/fintracka/sync.py`
- Modify: `src/fintracka/api.py`
- Test: `tests/test_savings_goals.py`
- Test: `tests/test_api.py`

**Interfaces:**
- Produces `reconcile_savings_draws(connection, through_month: str) -> None`.
- Produces `reconcile_savings_transactions(connection, transaction_ids: Sequence[str]) -> None`.
- Produces `assign_savings_withdrawal(connection, transaction_id: str, destination: str, goal_id: str | None, expected_updated_at: str) -> None`.
- Consumes existing `planning_snapshot(...)`, `apply_batch(...)`, transaction categorize/archive/split flows, and Planning target mutations.

- [ ] **Step 1: Write failing draw tests**

Assert Shopping target `$500` and actual `$1,500` move `$1,000` from Shopping to Pending transfer; no Planning target draws the full spend; an `$800` goal balance draws `$800` and reports `$200` uncovered; and non-savings-account withdrawals never affect goal balances.

- [ ] **Step 2: Write failing settlement and review-focus tests**

Cover one exact withdrawal within seven days, no match at eight days, no automatic partial/aggregate/ambiguous match, replay idempotency, provider modification/removal, recategorization, archive/restore, and a settled draw that later shrinks becoming an unassigned withdrawal without changing the bank-total equation.

- [ ] **Step 3: Verify tests fail**

Run: `.venv/bin/pytest tests/test_savings_goals.py -k 'draw or withdrawal or settlement' -v`

Expected: FAIL because reconciliation is not implemented.

- [ ] **Step 4: Implement draw reconciliation and matching**

Reuse Planning's included-spending totals. Append paired goal/Pending-transfer entries for desired draw deltas. Settle only a unique conservative match. Preserve every unmatched amount for explicit assignment; never mutate prior ledger rows.

- [ ] **Step 5: Wire all mutation callers**

After a successful provider batch, transaction category/archive/split/manual-cash mutation, or Planning target change, reconcile activation-through-current months inside the same SQLite write transaction. A failure rolls back both the source change and savings adjustments.

- [ ] **Step 6: Run focused integration tests**

Run: `.venv/bin/pytest tests/test_savings_goals.py tests/test_api.py -k 'savings or planning_target or categorize or archive' -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/fintracka/savings_goals.py src/fintracka/sync.py src/fintracka/api.py tests/test_savings_goals.py tests/test_api.py
git commit -m "feat: reconcile savings spending and withdrawals"
```

### Task 5: Monthly history, retirement valuations, reviews, and undo

**Files:**
- Modify: `src/fintracka/savings_goals.py`
- Modify: `src/fintracka/savings.py`
- Test: `tests/test_savings_goals.py`

**Interfaces:**
- Produces `savings_goal_overview(connection, month: str, owner: str | None = None) -> SavingsGoalOverview`.
- Produces `savings_goal_detail(connection, goal_id: str, through_month: str) -> SavingsGoalDetail`.
- Produces `generate_month_review(connection, month: str) -> SavingsMonthReview`, `accept_month_review(...)`, and `ignore_month_review(...)`.
- Produces `record_retirement_valuation(...)` and `undo_savings_event(...)`.

- [ ] **Step 1: Write failing history and reconciliation tests**

Assert each monthly row exposes opening, additions, spending draws, withdrawals, earnings/valuation changes, manual adjustments, and closing; Combined equals Regular plus Retirement; owner filtering works; lagging balance snapshots create a visible mismatch without an automatic balancing entry.

- [ ] **Step 2: Write failing retirement tests**

Assert explicit Fidelity/manual Roth contributions count toward the monthly target while valuation gains/losses change balance but not contribution attainment; Ariela and David remain separate until Combined is requested.

- [ ] **Step 3: Write failing review and undo tests**

Assert `$3,000` targets and `$2,580` actual spending suggest `$420`; a `$350` cash surplus caps it at `$350`; absent money produces `waiting`; a later deposit is allocated only once in its real month and linked to the prior review; ignore is stable; undo appends the exact opposite entry.

- [ ] **Step 4: Implement overview/detail/review/undo queries**

Compute expected-to-date from effective monthly targets starting at activation, cap visual progress at 100%, report ahead-of-plan dollars, keep zero-target goals in lists but out of allocation arcs, and expose Emergency value in months of essential Planning spending.

- [ ] **Step 5: Run domain suite**

Run: `.venv/bin/pytest tests/test_savings.py tests/test_savings_goals.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fintracka/savings.py src/fintracka/savings_goals.py tests/test_savings_goals.py
git commit -m "feat: add savings history and monthly reviews"
```

### Task 6: Strict Savings API

**Files:**
- Modify: `src/fintracka/api.py`
- Modify: `tests/test_api.py`

**Interfaces:**
- Produces `GET /api/v1/savings/initialization-preview?activation_month=YYYY-MM`, expanded `GET /api/v1/savings/{month}`, `GET /api/v1/savings/goals/{goal_id}?through_month=YYYY-MM`, and `POST /api/v1/savings/allocation-preview`.
- Produces `POST /api/v1/savings/initialize`, `POST /api/v1/savings/goals`, `PATCH /api/v1/savings/goals/{goal_id}`, `DELETE /api/v1/savings/goals/{goal_id}`, and `POST /api/v1/savings/goals/{goal_id}/archive`.
- Produces `PUT /api/v1/savings/allocation-plans/{pool}`, `POST /api/v1/savings/withdrawals/{transaction_id}/assign`, `POST /api/v1/savings/reviews/{month}/accept`, `POST /api/v1/savings/reviews/{month}/ignore`, and `POST /api/v1/savings/events/{event_id}/undo`.
- Extends existing account and manual-asset PATCH payloads with nullable `savings_pool` rather than creating parallel assignment endpoints.
- Consumes every public domain interface from Tasks 2–5.

- [ ] **Step 1: Write failing API contract tests**

Cover exact response shapes and status codes `201/200/204/409/422`; missing CSRF; hostile Host/Origin; unexpected fields; stale revisions; invalid cents/month/owner/pool/icon/color; duplicate category links; and absence of provider secrets/raw payloads.

- [ ] **Step 2: Verify API tests fail**

Run: `.venv/bin/pytest tests/test_api.py -k savings -v`

Expected: FAIL for missing routes/models.

- [ ] **Step 3: Add strict Pydantic models and routes**

Keep route functions thin: validate payloads, enter `_write_transaction`, invoke one domain operation, translate domain errors to `404/409/422`, and serialize dataclasses with `asdict`.

- [ ] **Step 4: Extend account/manual-asset responses and mutations**

Expose and validate `savings_pool`; default existing depository savings selected for Savings to `regular` only during reviewed initialization, and manual investments to `retirement` only when assigned rather than by provider-name guessing.

- [ ] **Step 5: Run API and security tests**

Run: `.venv/bin/pytest tests/test_api.py tests/test_security.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fintracka/api.py tests/test_api.py
git commit -m "feat: expose savings goal API"
```

### Task 7: Savings overview, doughnut, details, and icons

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/src/savings/model.ts`
- Create: `frontend/src/savings/icons.tsx`
- Create: `frontend/src/savings/SavingsDonut.tsx`
- Create: `frontend/src/savings/GoalDrawer.tsx`
- Modify: `frontend/src/savings/SavingsPage.tsx`
- Modify: `frontend/src/styles.css`
- Create: `frontend/tests/savings-model.test.ts`

**Interfaces:**
- Produces typed `SavingsGoalOverview`, `SavingsGoal`, `SavingsMonthPoint`, and `SavingsGoalDetail` matching Task 6.
- Produces `buildSavingsArcs(goals)`, `SavingsIcon`, `SavingsDonut`, and `GoalDrawer`.

- [ ] **Step 1: Pin the icon dependency**

Run: `npm --prefix frontend install --save-exact lucide-react@1.61.0`

Expected: `package.json` and lockfile contain exact version `1.61.0`.

- [ ] **Step 2: Write failing pure model tests**

Assert arc shares use monthly allocation basis points, funded arcs cap at 100%, zero-target goals stay out of arcs, owner colors map David/blue, Ariela/pink, Shared/dark purple, and malformed totals do not produce invalid SVG values.

- [ ] **Step 3: Implement typed model, controlled icons, and chart**

Use only allowlisted Lucide imports. Render the allocation background in translucent goal color and funded progress in solid color with accessible text equivalents; do not add another chart dependency.

- [ ] **Step 4: Rebuild the overview**

Keep existing account/manual-asset/activity sections, add Combined-default split control persisted under `fintracka.savings.ownerSplit`, Regular/Retirement/reconciliation metrics, doughnut and cards, monthly total chart, empty/setup states, and clickable goal detail drawer.

- [ ] **Step 5: Run frontend unit/type/build checks**

Run: `npm --prefix frontend test -- tests/savings-model.test.ts && npm --prefix frontend run typecheck && npm --prefix frontend run build`

Expected: PASS; production build completes.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/savings frontend/src/styles.css frontend/tests/savings-model.test.ts
git commit -m "feat: visualize savings goals"
```

### Task 8: Goal manager, allocation controls, and monthly review UI

**Files:**
- Create: `frontend/src/savings/GoalManager.tsx`
- Create: `frontend/src/savings/AllocationRules.tsx`
- Create: `frontend/src/savings/MonthlySavingsReview.tsx`
- Create: `frontend/src/savings/allocation.ts`
- Modify: `frontend/src/savings/SavingsPage.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/tests/savings-allocation.test.ts`
- Modify: `frontend/e2e/fintracka.spec.ts`

**Interfaces:**
- Produces pure `redistributeTargets(rows, changedGoalId, requestedBasisPoints) -> AllocationRow[]` matching backend rounding rules.
- Consumes Task 6 routes and Task 7 types/icons.

- [ ] **Step 1: Write failing allocation-control tests**

Assert percentage changes preserve total cents, direct dollar edits leave other dollars unchanged, locked goals stay fixed, editing a locked goal unlocks it plus one partner, all results total exactly, and zero totals remain stable.

- [ ] **Step 2: Implement allocation rules view**

Build connected range controls, dollar inputs, derived percentages, Lock All/Unlock All, accessible Move up/Move down controls plus native drag enhancement, and live shortfall/excess simulation. Save the complete pool plan atomically.

- [ ] **Step 3: Implement goal manager**

Support one-level hierarchy, add/edit, owner, controlled icon/color, monthly target, unique linked Planning category, archive, delete-unused, active filter, and optimistic conflict refresh.

- [ ] **Step 4: Implement monthly review view**

Show target/actual/capped suggestion, deposit-match state, distribution preview, Add/Move/Ignore actions, and review history without implying waiting money was already saved.

- [ ] **Step 5: Add Playwright savings workflow**

Mock external providers but use the real local API/database. Cover setup preview, `$25,000` Emergency split, `$500/$400/$100` targets, `$800` priority allocation, linked Shopping overage, one withdrawal settlement, owner split, category drawer, and month history.

- [ ] **Step 6: Run frontend and Playwright suites**

Run: `npm --prefix frontend test && npm --prefix frontend run typecheck && npm --prefix frontend run build && npm --prefix frontend run test:e2e`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/savings frontend/src/styles.css frontend/tests/savings-allocation.test.ts frontend/e2e/fintracka.spec.ts
git commit -m "feat: manage savings plans and reviews"
```

### Task 9: Recovery documentation and full verification

Implementation note: Savings activation remains an explicit UI action after a read-only preview; verification never initializes the live user database.

**Files:**
- Modify: `README.md`
- Modify: `RECOVERY_RUNBOOK.md`
- Modify: `SECURITY.md`
- Modify: `docs/superpowers/plans/2026-10-26-savings-goal-ledger.md`

**Interfaces:**
- Documents activation, initialization preview, Regular/Retirement pools, pending transfers, manual withdrawal assignment, undo, and database restore.

- [ ] **Step 1: Update user and recovery documentation**

Document that setup starts this month, opening allocation is `$25,000` Emergency plus remainder General Savings, Pershing is intentionally unsupported for now, and initialization must be preceded by a verified local backup.

- [ ] **Step 2: Run targeted live-data-safe checks**

Run initialization preview against the local database without committing it. Confirm the preview equation balances and no secrets or transaction descriptions appear in logs/API errors. Do not initialize live goal data until the user reviews the preview in the UI.

- [ ] **Step 3: Run full verification**

Run: `scripts/verify.sh`

Expected: backend tests, frontend tests, typecheck, production build, Playwright, `pip-audit`, and `npm audit` all pass.

- [ ] **Step 4: Verify database safety**

Run SQLite integrity and foreign-key checks on a restored copy of the latest backup, then migrate the copy through 014 and verify existing account/transaction/manual-asset counts are unchanged.

- [ ] **Step 5: Inspect repository diff and secret surfaces**

Review staged paths, generated frontend assets, logs, SQLite files, browser storage keys, and API fixtures. Commit only source, tests, lockfile, and documentation; never commit the live database, backups, screenshots, or credentials.

- [ ] **Step 6: Commit**

```bash
git add README.md RECOVERY_RUNBOOK.md SECURITY.md docs/superpowers/plans/2026-10-26-savings-goal-ledger.md
git commit -m "docs: explain savings goal recovery"
```
