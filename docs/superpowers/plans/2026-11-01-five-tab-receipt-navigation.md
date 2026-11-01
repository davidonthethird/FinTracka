# Five-Tab Receipt Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the iPhone navigation to one reliable five-item row while preserving obvious access to receipt scanning.

**Architecture:** Remove Receipts from the persistent navigation and render its entry action in Transactions. Treat all receipt routes as part of Transactions for active-tab state. Preserve the existing receipt routes and provider.

**Tech Stack:** React 19, TypeScript, CSS, Vitest

**Spec:** `docs/superpowers/specs/2026-11-01-five-tab-receipt-navigation-design.md`

## Global Constraints

- Keep exactly five persistent destinations.
- Preserve all `/receipts` routes and receipt security boundaries.
- Add no dependency.
- Respect `env(safe-area-inset-bottom)` and 44-pixel touch targets.

## Review Focus

- A receipt sub-route highlights Transactions, not no tab.
- The transaction receipt action reaches the receipt inbox without changing browser security behavior.
- The navigation remains one row on a 320-pixel viewport.
- Receipt capture/review routes continue rendering.
- Desktop layout does not regress.

---

### Task 1: Five-tab viewer navigation

**Files:**
- Modify: `frontend/src/viewer/ViewerApp.tsx`
- Modify: `frontend/src/viewer/TransactionsPage.tsx`
- Modify: `frontend/src/viewer/viewer.css`
- Test: `frontend/tests/viewer-navigation.test.tsx`

**Interfaces:**
- Consumes: existing `navigate(path: string)` and `/receipts` routes.
- Produces: five navigation destinations and `TransactionsPage` receipt navigation callback.

- [ ] **Step 1: Write failing navigation tests**

Assert that the navigation model has five destinations without Receipts, receipt routes resolve to Transactions, the Transactions page exposes a Scan receipt action, and mobile CSS uses five columns with one-row safe-area sizing.

- [ ] **Step 2: Run the focused test and verify the expected failures**

Run: `npm test -- viewer-navigation.test.tsx`

Expected: FAIL because Receipts is still a sixth destination and Transactions has no receipt action.

- [ ] **Step 3: Implement the minimum viewer changes**

Export the navigation model and active-path helper, pass `navigate` into Transactions, add the receipt action, and keep the fixed navigation to a single five-column row.

- [ ] **Step 4: Verify focused and full frontend suites**

Run: `npm test -- viewer-navigation.test.tsx && npm test && npm run typecheck:viewer && npm run build:viewer`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit only the spec, plan, test, and viewer files with message `fix: keep mobile viewer navigation to five tabs`.
