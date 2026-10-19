# Drawer Category Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, scoped transaction-category editing to the Planning and Reports side drawers while reusing FinTracka's audited categorization engine.

**Architecture:** A shared frontend categorization module owns the three scope values, safe browser-preference persistence, labels, and segmented control. Planning and Reports receive the existing transaction revision fields in their read models, call the existing categorize/undo endpoints, and refresh their current drawer and chart in place after successful mutations.

**Tech Stack:** React 19, TypeScript 7, FastAPI, Pydantic, SQLite, Vitest, Pytest, Playwright

**Spec:** `docs/superpowers/specs/2026-10-19-drawer-category-editing-design.md`

## Global Constraints

- Reuse the existing `one_time`, `future`, and `past_and_future` backend behavior; add no new categorization rules or schema migration.
- Default an absent or invalid saved scope to `one_time`.
- Store only the scope preference in browser storage; never store transaction data, account data, credentials, or OAuth payloads there.
- Force cash withdrawals to `one_time`.
- Preserve session-cookie, CSRF, strict Host/Origin, audit, undo, and optimistic `updated_at` enforcement.
- Keep the Planning or Reports drawer open and background scroll position stable during refresh.
- Add no new runtime dependency.

## Review Focus

- Stale `updated_at`: the editor remains open, reports the conflict, and refreshes instead of claiming success.
- Invalid or unavailable local storage: the UI falls back to `one_time` and categorization remains usable.
- Rule scope moves several transactions: affected totals and all visible drawer rows refresh, not just the selected row.
- A transaction moves out of the current category/path: the row disappears without closing the drawer or leaving stale totals.
- Split ledger entries sharing one transaction revision: repeated entry rows do not cause duplicate mutation requests or broken selection state.

---

### Task 1: Shared categorization scope preference and control

**Files:**
- Create: `frontend/src/transactions/categorization.ts`
- Create: `frontend/src/transactions/CategorizationScopeControl.tsx`
- Create: `frontend/tests/categorization.test.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Produces: `CategorizationScope = "one_time" | "future" | "past_and_future"`
- Produces: `readCategorizationScope(storage?: Pick<Storage, "getItem">): CategorizationScope`
- Produces: `writeCategorizationScope(scope: CategorizationScope, storage?: Pick<Storage, "setItem">): void`
- Produces: `effectiveCategorizationScope(scope: CategorizationScope, isCashWithdrawal: boolean): CategorizationScope`
- Produces: `scopeMessage(scope: CategorizationScope): string`
- Produces: `CategorizationScopeControl({ value, onChange, disabled? })`

- [ ] **Step 1: Write failing unit tests for safe preference behavior**

Add tests asserting that the missing value, an unknown value, and a throwing storage implementation return `one_time`; each valid scope round-trips; and `effectiveCategorizationScope("past_and_future", true)` returns `one_time`.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `cd frontend && npm test -- categorization.test.ts`

Expected: FAIL because the shared module does not exist.

- [ ] **Step 3: Implement the shared scope helpers and segmented control**

Use storage key `fintracka-categorization-scope`. Render `1×`, `→`, and `↔` as buttons with `aria-pressed`, exact descriptive `aria-label`/`title` text from the spec, and persist only on a user selection.

- [ ] **Step 4: Replace the Transactions page's private scope type/select**

Initialize Transactions with `readCategorizationScope()`, render `CategorizationScopeControl`, persist changes through `writeCategorizationScope`, and reuse `effectiveCategorizationScope` plus `scopeMessage` in category and subcategory saves.

- [ ] **Step 5: Add compact and responsive styles**

Add `.categorization-scope` styles using existing tokens, clear selected/focus states, and wrapping that does not increase the drawer's minimum width.

- [ ] **Step 6: Run frontend unit and type checks**

Run: `cd frontend && npm test && npm run typecheck`

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/transactions/categorization.ts frontend/src/transactions/CategorizationScopeControl.tsx frontend/tests/categorization.test.ts frontend/src/App.tsx frontend/src/styles.css
git commit -m "feat: share persistent categorization scope"
```

### Task 2: Supply editable transaction metadata to both drawers

**Files:**
- Modify: `src/fintracka/api.py`
- Modify: `src/fintracka/reports.py`
- Modify: `tests/test_api.py`

**Interfaces:**
- Produces on Planning transaction rows: `category_id: str | None`, `updated_at: str`, `is_cash_withdrawal: bool`
- Produces on Reports `entries`: `category_id: str | None`, `updated_at: str`, `is_cash_withdrawal: bool`
- Consumes: the existing transaction table fields and existing ledger-entry identity

- [ ] **Step 1: Write failing Planning API assertions**

Extend `test_planning_api_exposes_subcategory_breakdown_and_transactions` to assert each drawer row includes the current category identifier, transaction revision, and withdrawal marker.

- [ ] **Step 2: Write failing Reports API assertions**

Extend `test_cash_flow_report_includes_clickable_transaction_drilldowns` to assert the same three fields exist on every transaction-backed flow entry and match the underlying transaction.

- [ ] **Step 3: Run the focused backend tests and confirm failure**

Run: `.venv/bin/pytest tests/test_api.py -k 'planning_api_exposes_subcategory_breakdown_and_transactions or cash_flow_report_includes_clickable_transaction_drilldowns' -q`

Expected: FAIL on missing response fields.

- [ ] **Step 4: Extend the Planning query and response mapping**

Select `t.category_id`, `t.updated_at`, and `t.is_cash_withdrawal` in `planning_category_transactions`; expose them without changing amount or split-entry behavior.

- [ ] **Step 5: Extend Reports detail lookup and flow entries**

Select the same fields in `cash_flow_paths` transaction details and copy them into each transaction-backed entry. For split entries, keep the effective ledger category in `category_id` while using the parent transaction's revision and withdrawal marker.

- [ ] **Step 6: Run focused and related backend tests**

Run: `.venv/bin/pytest tests/test_api.py tests/test_budgets_reports.py tests/test_planning.py -q`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/fintracka/api.py src/fintracka/reports.py tests/test_api.py
git commit -m "feat: expose drawer categorization metadata"
```

### Task 3: Add category editing to the Planning drawer

**Files:**
- Modify: `frontend/src/planning/PlanningPage.tsx`
- Modify: `frontend/src/planning/CategoryDrawer.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/e2e/fintracka.spec.ts`

**Interfaces:**
- Consumes: `CategorizationScopeControl`, `effectiveCategorizationScope`, `scopeMessage`
- Consumes: `POST /transactions/{id}/categorize` with `{ expected_updated_at, category_id, scope }`
- Consumes: `POST /categorizations/{undo_id}/undo`
- Produces: `CategoryDrawer` props `categories`, `scope`, `onScopeChange`, `onCategorize`, and `onUndo`

- [ ] **Step 1: Add a failing Planning drawer browser test**

Open a Planning category, set `↔`, edit one listed transaction into another expense category, and assert: the request sends `past_and_future`; the status gives the affected count; the drawer remains open; the row leaves the selected category; chart totals refresh; and the background scroll position does not jump. Add a conflict-response case that keeps the row editor visible with an error.

- [ ] **Step 2: Run the focused browser test and confirm failure**

Run: `cd frontend && npx playwright test -g 'edits categories from planning drawer'`

Expected: FAIL because drawer editing controls do not exist.

- [ ] **Step 3: Add Planning page mutation and refresh orchestration**

Load expense categories, own the persisted scope and drawer status/undo state, call the existing categorize endpoint, increment `revision`, then re-fetch the selected category's transactions using its current category ID and owner context without clearing `selected` or `returnFocus`.

- [ ] **Step 4: Add compact row editing to `CategoryDrawer`**

Render the scope control once above the transaction list. Each row gets Edit; edit mode renders a category select and Cancel. Selection saves immediately, disables that row while pending, and retains edit mode on failure. Show an `aria-live` status and Undo action.

- [ ] **Step 5: Handle withdrawals and duplicate split rows**

Display that withdrawals apply once and send `one_time`. Key editing state by `transaction_id`, and disable sibling split rows for the same transaction while its request is pending so one user action sends one mutation.

- [ ] **Step 6: Style and verify the Planning drawer**

Keep amount alignment and existing drawer metrics intact; allow the row editor and scope control to wrap at narrow widths.

Run: `cd frontend && npm run typecheck && npx playwright test -g 'planning drawer'`

Expected: TypeScript and focused browser tests pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/planning/PlanningPage.tsx frontend/src/planning/CategoryDrawer.tsx frontend/src/styles.css frontend/e2e/fintracka.spec.ts
git commit -m "feat: edit categories from planning drawer"
```

### Task 4: Add category editing to the Reports drawer

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/e2e/fintracka.spec.ts`

**Interfaces:**
- Consumes: shared categorization scope interfaces from Task 1
- Consumes: enriched `FlowEntry` fields from Task 2
- Produces: `FlowDrawer` props `categories`, `scope`, `onScopeChange`, `onCategorize`, and `onUndo`

- [ ] **Step 1: Add a failing Reports drawer browser test**

Open a terminal flow category, set `→`, edit a transaction, and assert: the request sends `future`; the drawer remains open; the moved row disappears; node amounts/percentages update; Undo restores it; and the selected scope remains `→` after page reload.

- [ ] **Step 2: Run the focused browser test and confirm failure**

Run: `cd frontend && npx playwright test -g 'edits categories from reports drawer'`

Expected: FAIL because Reports drawer editing controls do not exist.

- [ ] **Step 3: Make Reports data refreshable without closing selection**

Add a Reports revision state and pass it to cash-flow, flow-path, spending, and owner queries. After save or undo, increment the revision and preserve `selection`; filter the refreshed entry IDs against the selected path and keep the drawer open even when its transaction list becomes empty.

- [ ] **Step 4: Add editing behavior to `FlowDrawer`**

Use the same scope control, row Edit/select/Cancel flow, withdrawal override, status, affected count, pending state, and Undo behavior as Planning. Reuse shared labels rather than duplicating scope copy.

- [ ] **Step 5: Run focused frontend verification**

Run: `cd frontend && npm test && npm run typecheck && npx playwright test -g 'edits categories from (planning|reports) drawer'`

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/styles.css frontend/e2e/fintracka.spec.ts
git commit -m "feat: edit categories from reports drawer"
```

### Task 5: Full verification and documentation check

**Files:**
- Modify only if behavior changed: `README.md`

**Interfaces:**
- Consumes: all prior task outputs
- Produces: a release-ready verified feature with no new secret-bearing storage

- [ ] **Step 1: Run the complete backend suite**

Run: `.venv/bin/pytest -q`

Expected: all tests pass.

- [ ] **Step 2: Run complete frontend verification**

Run: `cd frontend && npm test && npm run typecheck && npm run build && npm run test:e2e`

Expected: unit tests, type check, production build, and Playwright pass.

- [ ] **Step 3: Inspect browser storage and generated assets**

Verify browser storage contains only `fintracka-categorization-scope` for this feature and one of the three allowed values. Search the production assets for transaction fixture details, credentials, and OAuth payloads; expect no live data or secret.

- [ ] **Step 4: Confirm repository cleanliness and unrelated changes**

Run: `git status --short && git diff --check`

Expected: no whitespace errors; do not stage or modify the user's existing `tests/test_readiness.py` change.

- [ ] **Step 5: Commit any necessary README clarification**

Only if the README documents drawer behavior, update it and commit separately:

```bash
git add README.md
git commit -m "docs: describe drawer category editing"
```

