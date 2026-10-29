# Mobile Expandable Financial Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hosted viewer's mobile report wheel with a polished, vertically scrollable financial-flow map that expands from income through groups, categories, subcategories, and exact transactions while preserving the desktop Sankey.

**Architecture:** Keep `cash_flow_paths` authoritative and add only nullable subcategory metadata to its published entries. A pure TypeScript module will derive and reconcile the mobile hierarchy and deterministic coordinates; a React component will render accessible HTML cards over proportional SVG ribbons and own session-only expansion, filtering, zoom, and fullscreen state. The existing Recharts desktop Sankey and existing read-only drawer remain in place.

**Tech Stack:** Python 3.11+, SQLite, Pydantic, TypeScript, React 19, SVG, Lucide React, Recharts (desktop only), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-mobile-expandable-financial-flow-design.md`

## Global Constraints

- Do not change ledger arithmetic, transaction categorization, transfer exclusions, Savings-transfer treatment, or reporting totals.
- Do not add a runtime dependency.
- Keep the existing desktop Sankey behavior at viewport widths of 1000px and above.
- Keep the remote viewer read-only and store no financial data or view state in localStorage, sessionStorage, IndexedDB, Cache Storage, or a service worker.
- At scale `1`, use normal document scrolling and do not trap one-finger vertical gestures inside the chart.
- All amounts remain integer minor units; all rendered children must reconcile to their parent before they are shown.
- Every interactive control and node must be keyboard accessible and at least 44x44 CSS pixels on touch screens.
- Preserve the current fallback when `cash_flow_paths` is missing, partial, or invalid.
- Preserve rolling compatibility with an already-published schema-v1 snapshot that lacks the two new subcategory fields.

## Review Focus

- A split transaction whose parent subcategory belongs to a different effective split category must publish `null`, while an older schema-v1 snapshot without the new fields must still validate during rollout (Task 1 tests).
- Positive refund entries mixed into a spending category must reconcile through category, owner, and subcategory totals without turning a negative net branch into a visible expense (Task 2 test).
- Fully expanding a dense 30–50 category graph at 320px must produce increasing, non-overlapping coordinates and no horizontal page overflow (Tasks 2 and 6 tests).
- Changing month or owner while a branch is selected must clear stale IDs, selection, pan, and expansion state (Tasks 3 and 6 tests).
- Pinch/pan controls must not capture ordinary vertical scrolling at scale `1`, and reduced-motion mode must remove animated transitions (Tasks 5 and 6 tests).

---

## File Map

**Create**

- `frontend/src/viewer/mobileFlowLayout.ts` — pure hierarchy construction, reconciliation, owner filtering, percentages, and deterministic coordinates.
- `frontend/src/viewer/MobileExpandableSankey.tsx` — mobile controls, expansion state, HTML nodes, SVG ribbons, selection, zoom/pan, and fullscreen.
- `frontend/tests/mobile-flow-layout.test.ts` — financial reconciliation and coordinate tests.
- `frontend/tests/mobile-expandable-sankey.test.tsx` — static accessibility and rendering contract tests without adding a DOM-testing dependency.

**Modify**

- `src/fintracka/reports.py` — attach category-compatible subcategory metadata to flow entries.
- `src/fintracka/remote_models.py` — publish nullable subcategory fields.
- `src/fintracka/remote_snapshot.py` — copy the two fields into the sanitized snapshot.
- `remote/src/contract.ts` — validate the fields at the Worker trust boundary.
- `tests/test_budgets_reports.py` and `tests/test_remote_snapshot.py` — Python behavior and allowlist tests.
- `remote/tests/contract-fixture.test.ts` and `tests/fixtures/remote_snapshot_v1.json` — shared contract coverage.
- `frontend/src/viewer/ReportFlow.tsx` — mount the mobile component and retain the desktop Sankey.
- `frontend/src/viewer/ReportsPage.tsx` — resolve category/subcategory selections to exact entries.
- `frontend/src/viewer/CategoryDrawer.tsx` — display owner context in read-only transaction rows.
- `frontend/src/viewer/viewer.css` — responsive flow layout, styling, focus, fullscreen, and reduced motion.
- `frontend/tests/viewer-pages.test.tsx` and `frontend/e2e/remote-viewer.spec.ts` — integration, responsiveness, gestures, and security regression coverage.

---

### Task 1: Publish Safe Subcategory Metadata in Flow Entries

**Files:**
- Modify: `src/fintracka/reports.py:109-239`
- Modify: `src/fintracka/remote_models.py:170-205`
- Modify: `src/fintracka/remote_snapshot.py:343-362`
- Modify: `remote/src/contract.ts:129-148`
- Modify: `tests/test_budgets_reports.py`
- Modify: `tests/test_remote_snapshot.py:80-105`
- Modify: `remote/tests/contract-fixture.test.ts`
- Modify: `tests/fixtures/remote_snapshot_v1.json`

**Interfaces:**
- Consumes: existing `cash_flow_paths(connection, month)` ledger entries and transaction/subcategory tables.
- Produces: nullable `subcategory_id` and `subcategory` on every newly published Python `RemoteFlowEntry`; the Zod/frontend fields are optional-nullable only to accept an already-stored schema-v1 snapshot during rolling deployment.

- [ ] **Step 1: Write the failing report test**

Add `test_cash_flow_paths_publish_only_category_compatible_subcategories` to `tests/test_budgets_reports.py`. Create two expense categories and one subcategory in each, categorize a transaction, assign its subcategory, then split the transaction across the two categories with `set_splits()`.

Assert that:

```python
entries = [entry for entry in cash_flow_paths(ledger, "2026-10")["entries"]
           if entry["transaction_id"] == transaction_id]
assert next(item for item in entries if item["category_id"] == parent_category)["subcategory_id"] == parent_subcategory
assert next(item for item in entries if item["category_id"] == other_category)["subcategory_id"] is None
assert next(item for item in entries if item["category_id"] == other_category)["subcategory"] is None
```

- [ ] **Step 2: Run the report test and verify it fails**

Run: `python -m pytest tests/test_budgets_reports.py::test_cash_flow_paths_publish_only_category_compatible_subcategories -q`  
Expected: FAIL because flow entries do not publish subcategory fields.

- [ ] **Step 3: Add category-compatible subcategories to `cash_flow_paths()`**

Extend the transaction detail query in `src/fintracka/reports.py` to join `subcategories` and select the subcategory ID, name, and owning category ID. When creating each flow entry, publish the ID/name only when `subcategory_category_id == entry.category_id`; otherwise publish `None`. This rule applies to unsplit and split entries without changing `LedgerEntry` or report totals.

- [ ] **Step 4: Extend the sanitized remote contract**

Add these exact fields to `RemoteFlowEntry` and `_cash_flow_paths_model()`:

```text
subcategory_id: string | null
subcategory: string | null
```

Update `test_nested_snapshot_models_publish_only_viewer_fields` so its exact allowlist includes both names. In the strict Zod entry schema use `z.string().nullable().optional()` for each field: the current publisher always emits them, but an older stored schema-v1 snapshot remains valid during rollout. Add contract assertions that a fixture entry without the fields is accepted and that non-string, non-null values are rejected.

- [ ] **Step 5: Regenerate the synthetic snapshot fixture canonically**

Regenerate `tests/fixtures/remote_snapshot_v1.json` from `e2e.server.seed_database`, the existing fixed `NOW`, `source_sequence=7`, `history_months=6`, and `snapshot_id="snapshot-test"`; serialize with `serialize_remote_snapshot()`. Do not use live household data. Then run:

```bash
python scripts/verify_remote_snapshot.py
```

Expected: `remote snapshot contract verified: <digest>` and no forbidden-field failure.

- [ ] **Step 6: Run the data-contract tests**

Run:

```bash
python -m pytest tests/test_budgets_reports.py tests/test_remote_snapshot.py -q
npm --prefix remote run test:ci -- tests/contract-fixture.test.ts
npm --prefix remote run typecheck
```

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```bash
git add src/fintracka/reports.py src/fintracka/remote_models.py src/fintracka/remote_snapshot.py remote/src/contract.ts tests/test_budgets_reports.py tests/test_remote_snapshot.py remote/tests/contract-fixture.test.ts tests/fixtures/remote_snapshot_v1.json
git commit -m "feat: publish report flow subcategories"
```

---

### Task 2: Build the Reconciled Mobile Flow Model and Layout

**Files:**
- Create: `frontend/src/viewer/mobileFlowLayout.ts`
- Create: `frontend/tests/mobile-flow-layout.test.ts`
- Modify: `frontend/src/viewer/ReportFlow.tsx:7-17` (add backward-compatible subcategory fields to `FlowEntry` and subcategory/owner fields to `FlowSelection`)

**Interfaces:**
- Consumes: `FlowGraph`, `FlowGroup`, `FlowEntry`, and `FlowOwner` from the existing report types/helpers.
- Produces:

```ts
export type MobileFlowOwner = "Everyone" | FlowOwner;
export type MobileFlowNodeKind = "source" | "hub" | "group" | "category" | "subcategory" | "terminal";
export interface MobileFlowItem { id: string; label: string; kind: MobileFlowNodeKind; amountMinor: number; percentBasisPoints: number; entryIds: string[]; color: string; ownerBasisPoints?: Partial<Record<FlowOwner, number>>; }
export interface MobileFlowSubcategory extends MobileFlowItem { kind: "subcategory"; subcategoryId: string | null; categoryId: string | null; }
export interface MobileFlowCategory extends MobileFlowItem { kind: "category"; categoryId: string | null; children: MobileFlowSubcategory[]; }
export interface MobileFlowGroup extends MobileFlowItem { kind: "group"; children: MobileFlowCategory[]; }
export interface MobileFlowModel { income: MobileFlowItem; sources: MobileFlowItem[]; groups: MobileFlowGroup[]; terminals: MobileFlowItem[]; householdSpendingMinor: number; visibleSpendingMinor: number; }
export interface MobileFlowPosition { id: string; kind: MobileFlowNodeKind; x: number; y: number; width: number; height: number; item: MobileFlowItem; }
export interface MobileFlowRibbon { id: string; sourceId: string; targetId: string; amountMinor: number; width: number; path: string; color: string; owner?: FlowOwner; entryIds: string[]; }
export interface MobileFlowLayout { width: number; height: number; nodes: MobileFlowPosition[]; ribbons: MobileFlowRibbon[]; }
export interface MobileFlowLayoutOptions { width: number; expandedSource: boolean; expandedGroupIds: ReadonlySet<string>; expandedCategoryIds: ReadonlySet<string>; splitByOwner: boolean; }
export function buildMobileFlowModel(report: FlowGraph, groups: FlowGroup[], owner: MobileFlowOwner): MobileFlowModel | null;
export function layoutMobileFlow(model: MobileFlowModel, options: MobileFlowLayoutOptions): MobileFlowLayout;
```

`MobileFlowLayoutOptions` contains `width`, `expandedSource`, `expandedGroupIds`, `expandedCategoryIds`, and `splitByOwner`. Positions use one coordinate system shared by HTML cards and SVG ribbons.

In `ReportFlow.tsx`, use these compatible types before the mobile component is introduced:

```ts
export type FlowEntry = { id: string; transaction_id: string; local_date: string; merchant: string | null; description: string; category: string; category_id: string | null; subcategory_id?: string | null; subcategory?: string | null; amount_minor: number; currency: string; spending_owner: FlowOwner | null };
export type FlowSelection = { categoryId: string | null; subcategoryId?: string | null; label: string; amountMinor: number; entryIds: string[]; owner?: FlowOwner };
```

- [ ] **Step 1: Write failing hierarchy/reconciliation tests**

Create a small graph fixture directly in `frontend/tests/mobile-flow-layout.test.ts` containing:

- Salary and Prior cash into Income.
- Essentials and Lifestyle groups.
- Groceries with `Food` and `No subcategory` entries, including a positive refund.
- David, Ariela, and Shared expenses.
- Money retained.

Assert:

```ts
expect(model.sources.map((item) => item.label)).toEqual(["Salary", "Prior cash"]);
expect(groceries.children.reduce((sum, item) => sum + item.amountMinor, 0)).toBe(groceries.amountMinor);
expect(model.terminals.map((item) => item.label)).toContain("Money retained");
expect(david.visibleSpendingMinor).toBe(/* exact David net spending */);
expect(davidGroceries.percentBasisPoints).toBe(/* percent of David spending, not household */);
```

Also assert an invalid link, missing entry, or non-reconciling category returns `null` or omits only that category's subcategory children as defined by the spec.

- [ ] **Step 2: Run the hierarchy tests and verify they fail**

Run: `npm --prefix frontend test -- tests/mobile-flow-layout.test.ts`  
Expected: FAIL because `mobileFlowLayout.ts` does not exist.

- [ ] **Step 3: Implement `buildMobileFlowModel()`**

Reuse `buildFlowGroups()` output as the validated group/category base. Build sources and terminal nodes from existing graph kinds. Aggregate each category's exact `entry_ids` by `(subcategory_id, subcategory)` using `-amount_minor`, including refunds. Apply owner filtering before aggregation. Omit non-positive visible categories/groups. Calculate integer basis points using the denominators fixed in the design, assigning rounding remainder to the last non-zero owner bucket so displayed shares reconcile to 10,000.

- [ ] **Step 4: Write failing coordinate tests**

For collapsed, partially expanded, and expand-all option sets at widths `288`, `343`, and `398`, assert:

```ts
expect(layout.height).toBeGreaterThan(collapsed.height);
expect(layout.nodes.every((node) => node.x >= 0 && node.x + node.width <= layout.width)).toBe(true);
expect(overlappingNodePairs(layout.nodes)).toEqual([]);
expect(layout.ribbons.every((ribbon) => ribbon.width >= MIN_VISIBLE_RIBBON_PX)).toBe(true);
```

Create a dense 50-category model and assert layout time is linear by checking the output node/ribbon count rather than using a timing threshold.

- [ ] **Step 5: Implement `layoutMobileFlow()`**

Use deterministic constants for card height, row gap, column bounds, minimum ribbon width, and indentation. Expanded groups insert category rows; expanded categories insert subcategory rows directly below that category rather than adding a fourth horizontal column. Return paths as SVG cubic Bézier `d` strings. Keep amount values separate from the visibility-floor width so labels never imply a larger value.

- [ ] **Step 6: Run the pure frontend tests**

Run:

```bash
npm --prefix frontend test -- tests/mobile-flow-layout.test.ts
npm --prefix frontend run typecheck:viewer
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/viewer/mobileFlowLayout.ts frontend/src/viewer/ReportFlow.tsx frontend/tests/mobile-flow-layout.test.ts
git commit -m "feat: model vertical mobile money flow"
```

---

### Task 3: Render the Expandable Accessible Mobile Map

**Files:**
- Create: `frontend/src/viewer/MobileExpandableSankey.tsx`
- Create: `frontend/tests/mobile-expandable-sankey.test.tsx`
- Modify: `frontend/src/viewer/viewer.css:44-49`

**Interfaces:**
- Consumes: `buildMobileFlowModel()`, `layoutMobileFlow()`, `FlowGraph`, `FlowGroup`, and `FlowSelection`.
- Produces:

```ts
export interface MobileExpandableSankeyProps {
  report: FlowGraph;
  groups: FlowGroup[];
  onSelect: (selection: FlowSelection) => void;
}
export function MobileExpandableSankey(props: MobileExpandableSankeyProps): JSX.Element;
```

- [ ] **Step 1: Write the failing static component tests**

Use `renderToStaticMarkup` with the Task 2 fixture and assert the component contains:

- Income, every collapsed group, Money retained, amounts, and spending percentages.
- `aria-expanded="false"` on expandable groups.
- Native controls named `Compact`, `Detailed`, `Expand all`, `Collapse all`, `Split spending by person`, `Everyone`, `David`, `Ariela`, `Shared`, `Search financial flow`, `Zoom in`, `Zoom out`, `Fit to screen`, `Reset view`, and `Enter fullscreen`.
- No `Save`, `Edit`, `Delete`, `Archive`, or publication control.

- [ ] **Step 2: Run the static test and verify it fails**

Run: `npm --prefix frontend test -- tests/mobile-expandable-sankey.test.tsx`  
Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the expansion and filtering state**

In `MobileExpandableSankey`, keep these values in React state only:

```ts
expandedSource: boolean
expandedGroupIds: Set<string>
expandedCategoryIds: Set<string>
owner: "Everyone" | "David" | "Ariela" | "Shared"
splitByOwner: boolean
query: string
selectedId?: string
```

Group and category toggles mutate only their own set. `Detailed` expands all groups one level; `Compact` collapses descendants; `Expand all` expands sources, groups, and reconciling category subtrees; `Collapse all` returns to the initial compact state. Search forms an effective expansion set without overwriting explicit expansion state.

When `report` identity changes, reset selection, query, expansion, scale, and pan before rendering the next month. When `owner` changes, reset selection and expansion before building the filtered model so stale node IDs cannot survive across views.

- [ ] **Step 4: Render HTML nodes over SVG ribbons**

Render one relative stage containing an SVG ribbon layer and absolutely positioned native buttons from the same `MobileFlowLayout` coordinates. Group/category/subcategory buttons expose `aria-expanded` and `aria-controls` where applicable. Selecting a node or ribbon applies a connected-path class; unrelated branches receive a faded class. A leaf calls `onSelect()` with its exact `entryIds`, `categoryId`, optional `subcategoryId`, amount, label, and owner.

- [ ] **Step 5: Add mobile visual styling**

Add `.mobile-flow-*` rules using existing `--teal`, `--david`, `--ariela`, and `--shared` variables. Use compact two-line labels, tabular amounts, proportional ribbons, 44px controls, sticky toolbar wrapping at 320px, and a two-line clamp with full accessible text/title. At this task, the chart remains scale `1`; gesture transforms come in Task 5.

- [ ] **Step 6: Run component tests and typecheck**

Run:

```bash
npm --prefix frontend test -- tests/mobile-expandable-sankey.test.tsx tests/mobile-flow-layout.test.ts
npm --prefix frontend run typecheck:viewer
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/viewer/MobileExpandableSankey.tsx frontend/src/viewer/viewer.css frontend/tests/mobile-expandable-sankey.test.tsx
git commit -m "feat: render expandable mobile money flow"
```

---

### Task 4: Integrate Exact Drilldowns and Preserve Desktop

**Files:**
- Modify: `frontend/src/viewer/ReportFlow.tsx:1-157`
- Modify: `frontend/src/viewer/ReportsPage.tsx:7-54`
- Modify: `frontend/src/viewer/CategoryDrawer.tsx`
- Modify: `frontend/src/viewer/viewer.css:44-49`
- Modify: `frontend/tests/viewer-pages.test.tsx:34-96`

**Interfaces:**
- Consumes: `MobileExpandableSankey` and its `FlowSelection` callback.
- Produces: responsive `ReportFlow` with `.mobile-flow-map` below 1000px and unchanged `.flow-sankey` at 1000px+, plus exact category/subcategory drawer rows.

- [ ] **Step 1: Update the integration test to describe the new responsive contract**

Replace wheel-specific assertions with:

```ts
expect(html).toContain("Expandable financial flow");
expect(html).toContain("Expand all");
expect(html).toContain("Essentials");
expect(html).not.toContain("flow-wheel");
```

Extend `selectedFlowTransactions` coverage so a split flow entry's published `subcategory_id`/`subcategory` overrides the base transaction's parent subcategory and only selected entry IDs reach the drawer.

- [ ] **Step 2: Run the viewer-page test and verify it fails**

Run: `npm --prefix frontend test -- tests/viewer-pages.test.tsx`  
Expected: FAIL on the wheel/new flow assertions or missing entry subcategory mapping.

- [ ] **Step 3: Mount the mobile component and remove the wheel implementation**

In `ReportFlow.tsx`, retain `buildFlowGroups`, `DesktopFlow`, and desktop focus behavior. Remove `Pie`, `PieChart`, `Sector`, wheel state/helpers, and mobile group/category duplicate lists. Render `MobileExpandableSankey` in `.mobile-flow-map`; use CSS to show it below 1000px and show `.flow-sankey` at 1000px and above.

- [ ] **Step 4: Pass exact subcategory selections through `ReportsPage`**

Extend `ReportSelection` with optional `subcategoryId` and `owner`, using the `FlowSelection` fields introduced in Task 2. In `selectedFlowTransactions()`, map `subcategory_id` and `subcategory` from the published flow entry, falling back to the base transaction only for older/missing fields. Compute drawer percentage from the selected visible amount and keep exact `entryIds`; do not re-query or recalculate the ledger.

- [ ] **Step 5: Preserve complete detail while removing mobile duplication**

Update `CategoryDrawer` transaction metadata to show `date · account · owner` when owner exists. Hide `.report-columns` below 1000px because the flow exposes categories and ownership; retain the existing By category/By person sections at 1000px+.

- [ ] **Step 6: Run integration tests and builds**

Run:

```bash
npm --prefix frontend test -- tests/viewer-pages.test.tsx tests/mobile-expandable-sankey.test.tsx tests/mobile-flow-layout.test.ts
npm --prefix frontend run typecheck:viewer
npm --prefix frontend run build:viewer
```

Expected: PASS; build emits `frontend/dist-viewer/index.html`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/viewer/ReportFlow.tsx frontend/src/viewer/ReportsPage.tsx frontend/src/viewer/CategoryDrawer.tsx frontend/src/viewer/viewer.css frontend/tests/viewer-pages.test.tsx
git commit -m "feat: replace mobile report wheel with flow map"
```

---

### Task 5: Add Zoom, Pan, Fit, Reset, and Fullscreen Without Trapping Scroll

**Files:**
- Modify: `frontend/src/viewer/MobileExpandableSankey.tsx`
- Modify: `frontend/src/viewer/viewer.css`
- Modify: `frontend/tests/mobile-expandable-sankey.test.tsx`
- Modify: `frontend/e2e/remote-viewer.spec.ts`

**Interfaces:**
- Consumes: the Task 3 stage and toolbar.
- Produces: bounded `scale` and `pan` transforms, pointer gesture handlers, Fullscreen API/fallback state, and reset semantics.

- [ ] **Step 1: Add failing browser assertions for view controls**

At a 390px viewport, assert:

- Default scale is `1` and the stage uses normal page scrolling.
- Zoom in changes scale by `0.2`; zoom is clamped to `[0.8, 2.4]`.
- Dragging changes pan only when scale is greater than `1`.
- Fit returns scale to `1` and zero pan without collapsing branches.
- Reset returns scale/pan, selection, query, owner, split mode, and expansion to their initial values.
- Fullscreen enters the browser API or the fixed overlay fallback and Escape exits.

Dispatch a two-pointer sequence to verify pinch scaling. Emulate reduced motion and assert transition duration is disabled.

- [ ] **Step 2: Run the targeted browser test and verify it fails**

Run: `npm --prefix frontend run test:e2e -- e2e/remote-viewer.spec.ts --grep "remote viewer is read-only"`  
Expected: FAIL on the new mobile flow controls.

- [ ] **Step 3: Implement bounded zoom and pointer gestures**

Add `scale`, `pan`, and active-pointer state inside `MobileExpandableSankey`. Use Pointer Events and pointer capture; one active pointer at scale `1` does not call `preventDefault`, while two pointers perform pinch scaling. Enable drag pan only above scale `1`. Clamp pan to the transformed stage bounds after every scale/layout change.

- [ ] **Step 4: Implement fit, reset, and fullscreen**

`Fit` sets scale `1` and zero pan while retaining expansion. `Reset` restores the complete initial view state specified in Step 1. Use `requestFullscreen()`/`exitFullscreen()` when supported; otherwise apply `.mobile-flow-fullscreen-fallback` as a fixed overlay. Listen for `fullscreenchange` and Escape and remove listeners on unmount.

- [ ] **Step 5: Add gesture and reduced-motion CSS**

At scale `1`, set the stage to `touch-action: pan-y`. In zoomed mode use `touch-action: none` and clip transformed content to the stage. Add fullscreen safe-area spacing, high-z-index toolbar, and `prefers-reduced-motion: reduce` rules that disable node/ribbon transforms and opacity transitions.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm --prefix frontend test -- tests/mobile-expandable-sankey.test.tsx
npm --prefix frontend run typecheck:viewer
npm --prefix frontend run test:e2e -- e2e/remote-viewer.spec.ts --grep "remote viewer is read-only"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/viewer/MobileExpandableSankey.tsx frontend/src/viewer/viewer.css frontend/tests/mobile-expandable-sankey.test.tsx frontend/e2e/remote-viewer.spec.ts
git commit -m "feat: add mobile flow navigation controls"
```

---

### Task 6: Verify Dense Expansion, Responsiveness, Read-only Security, and Desktop Regression

**Files:**
- Modify: `frontend/e2e/remote-viewer.spec.ts`
- Modify only if a discovered defect requires it: files owned by Tasks 1–5.

**Interfaces:**
- Consumes: the completed published contract and responsive flow implementation.
- Produces: end-to-end proof for the acceptance criteria; no new product interface.

- [ ] **Step 1: Replace all wheel-specific E2E checks**

For widths `320`, `375`, `390`, `430`, and `768`, assert `.mobile-flow-map` is visible, `.flow-sankey` is hidden, and `document.documentElement.scrollWidth <= window.innerWidth`. At `1280`, assert the reverse and exercise the existing desktop group focus/reset behavior.

- [ ] **Step 2: Add the complete mobile interaction path**

In one mobile test:

1. Expand two groups and assert both remain expanded.
2. Expand a category with subcategories and open one subcategory's drawer.
3. Confirm the drawer contains only its contributing transactions and includes account and owner text.
4. Use `Expand all`; assert stage height increases and the last visible node can be scrolled into view.
5. Search for a category; assert its path is expanded/highlighted, then clear search without losing explicit expansions.
6. Enable `Split spending by person`; assert David/Ariela/Shared labels or accessible ribbon names and percentages reconcile.
7. Focus one owner; assert percentages use that owner's spending and the empty-owner case shows an explicit empty state.
8. Change month; assert the mobile flow returns to compact scale-1 state.

- [ ] **Step 3: Preserve the existing security assertions**

Keep assertions that no mutation controls appear, no financial values reach console output, and all browser persistence remains empty:

```ts
expect(persistence).toEqual({ local: {}, session: {}, databases: [], caches: [], workers: 0 });
```

- [ ] **Step 4: Run the complete verification milestone**

Run:

```bash
python -m pytest tests/test_budgets_reports.py tests/test_remote_snapshot.py -q
python scripts/verify_remote_snapshot.py
npm --prefix remote run typecheck
npm --prefix remote run test:ci
npm --prefix frontend run typecheck:viewer
npm --prefix frontend test
npm --prefix frontend run build:viewer
npm --prefix frontend run test:e2e
```

Expected: every command exits `0`; Playwright reports no horizontal overflow at any required width and the desktop Sankey remains visible at 1280px.

- [ ] **Step 5: Inspect the final diff for scope and secrets**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~5..HEAD
rg -n "access_token|client_secret|keychain_account|raw_payload|sanitized_json" tests/fixtures/remote_snapshot_v1.json frontend/src/viewer remote/src
```

Expected: no whitespace errors; only planned files are staged/committed; no secret fields exist in the fixture or viewer payload. Ignore unrelated pre-existing untracked files rather than adding or deleting them.

- [ ] **Step 6: Commit any final test-only adjustments**

If Step 4 required test or defect corrections, commit only those exact files:

```bash
git add frontend/e2e/remote-viewer.spec.ts <exact-corrected-files>
git commit -m "test: verify expandable mobile financial flow"
```

If no corrections were needed, do not create an empty commit.

