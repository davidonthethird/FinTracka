# Remote Flow Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align remote transaction amounts and add a responsive, drillable financial-flow report that needs no horizontal chart scrolling.

**Architecture:** Keep the existing snapshot flow graph as the only data source. Add one viewer flow component with a Sankey desktop renderer and nested-wheel mobile renderer, while reusing the existing category drawer for final-category transactions.

**Tech Stack:** React 19, TypeScript, Recharts 3, Vitest, Playwright, existing viewer CSS.

**Spec:** `docs/superpowers/specs/2026-10-28-remote-flow-map-design.md`

## Global Constraints

- Add no dependency.
- Keep the hosted viewer read-only and browser-storage-free.
- Never introduce horizontal page overflow at supported widths 320, 375, 390, 430, 768, and 1280 pixels.
- Use `cash_flow_paths.nodes` and `cash_flow_paths.links` as the financial-flow source of truth.

## Review Focus

- Transactions without a spending owner align with owned transactions.
- Empty, missing, or partial `cash_flow_paths` data renders a safe fallback.
- Small expense categories remain discoverable through the complete category list.
- Group focus can always be reset and final categories still open transaction details.
- The mobile wheel and desktop Sankey calculate percentages from the same final-expense total.

---

### Task 1: Stable transaction amount column

**Files:**
- Modify: `frontend/src/viewer/TransactionsPage.tsx`
- Modify: `frontend/src/viewer/viewer.css`
- Test: `frontend/e2e/remote-viewer.spec.ts`

**Interfaces:**
- Consumes: `RemoteTransaction.spending_owner` and formatted amount text.
- Produces: a fixed `.owner-slot` plus fixed `.transaction-amount` grid contract for every row.

- [ ] **Step 1: Add an E2E assertion that owned and unowned amount cells share the same right edge.**
- [ ] **Step 2: Run the remote viewer E2E test and confirm the assertion fails.**
- [ ] **Step 3: Always render the owner slot and assign the amount its stable class; update the row grid and tabular alignment.**
- [ ] **Step 4: Re-run the targeted E2E test and confirm it passes at mobile and desktop widths.**

### Task 2: Responsive zoomable financial flow

**Files:**
- Create: `frontend/src/viewer/ReportFlow.tsx`
- Modify: `frontend/src/viewer/ReportsPage.tsx`
- Modify: `frontend/src/viewer/viewer.css`
- Test: `frontend/tests/viewer-pages.test.tsx`
- Test: `frontend/e2e/remote-viewer.spec.ts`

**Interfaces:**
- Consumes: `FlowReport` containing indexed `nodes` and `links`, plus the selected month's `RemoteTransaction[]`.
- Produces: `ReportFlow({ report, onCategory })`, where `onCategory(categoryId)` opens the existing category drawer.

- [ ] **Step 1: Add component assertions for flow overview labels, percentages, focus/reset controls, and safe fallback behavior.**
- [ ] **Step 2: Run the targeted Vitest file and confirm the new assertions fail.**
- [ ] **Step 3: Implement graph-derived group/category rows and the responsive Sankey/wheel renderers in `ReportFlow.tsx`.**
- [ ] **Step 4: Replace the current report bar-flow block with `ReportFlow` and route final-category selection to `CategoryDrawer`.**
- [ ] **Step 5: Add responsive CSS that switches renderers at 760px without horizontal overflow.**
- [ ] **Step 6: Add E2E coverage for group focus, reset, category drawer, and all supported viewport widths.**
- [ ] **Step 7: Run viewer unit tests, viewer build, and remote viewer E2E tests.**

### Task 3: Stage and publish verification

**Files:**
- Modify: `REMOTE_VIEWER_RUNBOOK.md` only if deployment behavior changes.

**Interfaces:**
- Consumes: built viewer worker and existing protected staging configuration.
- Produces: a protected staging deployment with synthetic data only.

- [ ] **Step 1: Run `./scripts/verify.sh` and confirm all suites pass.**
- [ ] **Step 2: Commit the viewer changes and documentation.**
- [ ] **Step 3: Deploy the viewer Worker to the existing staging environment without publishing real financial data.**
- [ ] **Step 4: Verify Access protection, transaction alignment, responsive flow rendering, and drill-down on staging.**
