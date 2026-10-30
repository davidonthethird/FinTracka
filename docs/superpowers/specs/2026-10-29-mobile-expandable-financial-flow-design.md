# Mobile Expandable Financial Flow Design

## Intent

Replace the hosted viewer's mobile report wheel with a polished vertical financial-flow map that preserves the information and drilldowns of FinTracka's desktop report without horizontal scrolling. The map starts with monthly income, branches into every active category group, and can expand through categories and subcategories to the exact transactions behind them.

The primary user is a household member checking the read-only viewer on an iPhone. Success means they can understand where money went at a glance, expand any combination of branches, and reach transaction detail without losing the overall flow.

## Goals

- Show the full existing graph: income sources/refunds/prior cash into the Income hub, then `Income -> group -> category -> subcategory -> transactions`, plus retained money and income adjustments.
- Keep every group independently expandable; multiple groups and categories may remain expanded simultaneously.
- Provide `Expand all` and `Collapse all`; expanding all lengthens the normal page instead of creating a nested scroll area.
- Keep amount, percentage, ownership, and transaction information available at the appropriate level.
- Make stream thickness proportional to the authoritative report amount and reconcile every visible child level to its parent.
- Keep the existing desktop/tablet Sankey unchanged at widths of 1000px and above.
- Preserve the viewer's read-only, no-browser-persistence security model.
- Support narrow iPhone portrait widths first, then landscape and tablets, without horizontal page overflow.

## Non-goals

- No changes to transaction categorization, transfer handling, savings-transfer rules, budgeting, or ledger calculations.
- No report editing from the hosted viewer.
- No new chart dependency or replacement of the desktop Sankey.
- No redesign of the other viewer tabs.
- No persistence of expansion, search, filter, zoom, or selection state beyond the current mounted viewing session.

## Anti-goals

- Do not squeeze the desktop horizontal Sankey into a phone width.
- Do not make people horizontally swipe to discover labels or amounts.
- Do not show so many columns at once that text overlaps or requires zoom to read.
- Do not invent subcategory totals when published transaction detail is unavailable.
- Do not allow zoom gestures to capture ordinary vertical page scrolling at the default scale.

## Approaches Considered

### 1. HTML nodes with an SVG ribbon layer — selected

Lay out accessible HTML cards in a compact vertical tree and render proportional SVG ribbons behind them using the same calculated coordinates. HTML keeps labels, amounts, controls, and touch targets readable; SVG supplies the continuous financial-map appearance. Expanding a branch recalculates row positions and grows the document height.

This is the closest match to the supplied reference while remaining accessible and naturally scrollable.

### 2. All-SVG expandable chart

Render cards, text, ribbons, and interaction entirely in SVG. Transforming the whole chart is straightforward, but responsive text, keyboard semantics, dynamic height, and 44px touch targets require substantially more custom code. Rejected because it increases complexity without improving the requested result.

### 3. Nested accordion with decorative rails

Use ordinary nested lists with approximate flow markers. This is the least code and most robust layout, but it no longer communicates proportional financial flow and does not match the desired design. Rejected because visual flow is a core requirement.

## Current System and Required Data Addition

`cash_flow_paths` remains the source of truth for report nodes, links, amounts, entry IDs, transfer exclusions, and Savings-transfer treatment. Its current published graph contains income, group, and category levels. Published transactions already include subcategory information, but a flow entry does not.

Add nullable `subcategory_id` and `subcategory` fields to each `cash_flow_paths.entries` item. They come from the transaction already backing that ledger entry. For an unsplit transaction, publish its assigned subcategory normally. For a split ledger entry, inherit the parent transaction's subcategory only when that subcategory belongs to the split entry's effective category; otherwise publish no subcategory for that split. The mobile component aggregates those exact entry amounts for the selected category into subcategory rows. A missing subcategory is shown as `No subcategory`. Aggregated subcategories must equal their category amount before they are rendered; if they do not reconcile, that category remains directly drillable to transactions and its subcategory expansion is omitted.

This addition affects the Python remote model, snapshot builder, TypeScript Worker contract, fixture, and frontend flow types. It does not change ledger arithmetic or the desktop graph structure.

Ownership uses each flow entry's existing effective `spending_owner`. The mobile component filters or splits already-published expense entries for Everyone, David, Ariela, and Shared using the same allocation/reconciliation rules already used by the desktop report helpers. Income remains the report's monthly income context; ownership controls change the displayed outflow branches, not who earned income.

Mobile preserves the desktop report's separate `Split spending by person` toggle. With the toggle off, Everyone shows combined category colors. With it on, Everyone shows David-blue, Ariela-pink, and Shared-dark-purple ribbon segments and owner shares within each expense node. The owner selector can then focus David, Ariela, or Shared; a focused owner shows only that owner's expense entries and uses that owner's color.

Percentages use explicit denominators:

- Everyone combined: each expense node is a percentage of total household spending.
- Everyone with person split: the node remains a percentage of household spending, and its David/Ariela/Shared shares are percentages of that node.
- A focused owner: each node is a percentage of that owner's total spending; the owner summary also states that owner's percentage of household spending.
- Incoming source nodes are percentages of total funding, not expense spending.

## Visual Structure

### Header and controls

The Reports page keeps the month selector and summary totals. The mobile flow section adds a compact sticky toolbar within the report:

- `Compact` / `Detailed`: compact collapses all descendants; detailed expands category groups one level.
- `Expand all` / `Collapse all`.
- Ownership selector: Everyone, David, Ariela, Shared.
- `Split spending by person` toggle, matching the desktop report.
- Search by group, category, or subcategory name.
- Zoom out, zoom in, fit, reset, and fullscreen controls.

Controls use icons plus accessible names. Frequently used controls remain visible; secondary zoom and fullscreen controls may sit in one compact overflow/control cluster so the toolbar wraps cleanly at 320px.

### Flow layout

- The Income card anchors the top of the flow.
- The Income card can expand its incoming side to show the desktop report's existing income sources, refund offsets, and prior-cash funding nodes with their amounts and percentages of total funding.
- A vertical income trunk runs down the left side.
- Group cards form the second column and are stacked in report order.
- Expanded categories form a compact third column beside their group.
- Expanded subcategories do not create a fourth squeezed column. They render as an indented focused section immediately below their category, with short connected ribbons.
- Lower groups move downward when earlier branches expand.
- Cards show label, amount, percentage of total spending, and expansion state.
- Leaf categories and subcategories are buttons that open details.
- Existing terminal nodes that are not expense groups, including Money retained and Income adjustments, appear as compact terminal cards so no desktop-flow information disappears on mobile.
- Flows and cards use the existing FinTracka palette. `Split spending by person` supplements category color with David blue, Ariela pink, and Shared dark purple segments; text labels remain the primary identifier.

The component computes deterministic row heights and y-positions from the expanded-state sets. The SVG viewBox matches the calculated content height, and the HTML node layer uses the same coordinates. Stream thickness uses a bounded proportional scale: amounts remain comparable, while a small minimum keeps low-value streams visible without implying a larger labeled value.

### Selection and focus

Selecting a card or ribbon highlights its ancestors, descendants, and connected streams. Unrelated branches fade to approximately 20% opacity. The selected card shows its amount, percentage of total spending, and, in split mode, owner shares. Tapping empty chart space clears selection.

Tapping a category with subcategories toggles its subcategory section. A separate `View details` action, or tapping a leaf, opens the existing read-only `CategoryDrawer`. Subcategory detail opens the same drawer filtered to that subcategory's entry IDs. Drawer rows continue to show merchant, date, account, amount, and ownership where available.

## Expansion Behavior

- Initial state: all groups collapsed, giving a compact whole-month overview.
- Income sources are collapsed into the Income card initially and can be expanded independently.
- Group tap: toggles that group's category rows without closing other groups.
- Category tap: toggles its subcategories when more than one meaningful subcategory exists; otherwise it opens transaction details.
- `Expand all`: expands every group and every category with reconciling subcategory data.
- `Expand all` also reveals the existing incoming income/refund/funding nodes.
- `Collapse all`: returns to the initial compact overview.
- Search expands the matching path temporarily and highlights matches without discarding the user's explicit expansion state.
- Changing month or ownership clears selection and resets expansion to compact, preventing stale node IDs from leaking between views.
- Expansion, selection, filters, and zoom live only in React memory.

## Zoom, Pan, Scrolling, and Fullscreen

At scale `1`, the chart fits the viewport width and participates in normal document scrolling. It has no independent vertical scrollbar and does not intercept one-finger vertical gestures.

Zoom controls and pinch gestures change a bounded chart scale. Once scale exceeds `1`, pointer dragging pans within the chart stage. `Fit` returns to scale `1` while preserving expansion; `Reset` returns to scale `1`, zero pan, no selection, and all branches collapsed. Fullscreen uses the browser Fullscreen API when available and falls back to a fixed viewport overlay when unavailable. Escape exits fullscreen.

Reduced-motion mode disables animated interpolation. Otherwise expansion and highlighting use short opacity and position transitions without spring physics.

## Component Boundaries

- `ReportFlow.tsx` retains the desktop `DesktopFlow` and chooses the mobile component below 1000px through responsive presentation, as it does today.
- `MobileExpandableSankey.tsx` owns mobile state, rendering, selection, zoom/pan, search, and fullscreen.
- `mobileFlowLayout.ts` is a pure module that builds the hierarchy, validates reconciliation, filters ownership, and returns deterministic node/ribbon coordinates.
- `ReportsPage.tsx` owns month selection and the existing drawer. It receives a category or subcategory selection from the mobile component and resolves exact published entries into drawer transactions.
- Existing `CategoryDrawer.tsx` gains optional owner-share and filtered-breakdown inputs only if required by the selected node; it remains read-only.
- `viewer.css` supplies responsive layout, colors, focus states, fullscreen presentation, and reduced-motion rules.

No new runtime dependency is introduced. Existing React, SVG, Lucide icons, and report helpers are reused.

## Failure and Empty States

- Missing or invalid `cash_flow_paths`: show the existing safe fallback and category totals.
- Missing flow entries: show group/category flow only; disable subcategory expansion and retain category drilldown when matching published transactions exist.
- Subcategory totals that fail reconciliation: omit only that subcategory branch and keep the parent category usable.
- No spending for an ownership filter: show an explicit empty outflow state while retaining income context and controls.
- Very long labels: two-line clamp in cards, with the full label in accessible text/title.
- Large graphs: layout remains linear in nodes and entries, and the SVG contains only currently visible ribbons.

## Accessibility

- Every node and toolbar action is a native button or keyboard-operable control with an explicit accessible name.
- Expansion uses `aria-expanded`; child regions use `aria-controls` where practical.
- Focus order follows the visual top-to-bottom hierarchy.
- Focus remains on the toggled parent after expansion; opening/closing the drawer follows the existing focus-restoration behavior.
- Amount and percentage text convey meaning independently of width or color.
- Touch targets are at least 44x44px.
- The map supports keyboard expansion, search, drawer opening, zoom controls, reset, and fullscreen.

## Testing and Acceptance

### Pure layout tests

- Builds group, category, and subcategory hierarchy from a valid report.
- Reconciles child amounts exactly, including split ledger entries.
- Handles `No subcategory`, absent entries, refunds, zero values, and owner filters.
- Produces stable increasing y-positions with no node overlap for collapsed, partially expanded, and fully expanded states.
- Keeps visible ribbon widths proportional and above the visibility floor.

### Component tests

- Multiple groups and categories remain expanded simultaneously.
- Expand all and collapse all work.
- Search expands and highlights the matching path.
- Category and subcategory selections pass exact entry IDs to the drawer.
- Month and owner changes reset stale interaction state.
- Reduced motion and keyboard behavior are honored.

### Browser tests

- Verify 320, 375, 390, 430, and 768px widths with no horizontal page overflow.
- Expand all on the dense fixture and confirm normal vertical page scrolling reaches every node.
- Exercise zoom, pan, fit, reset, and fullscreen without trapping default vertical scrolling.
- Verify owner filtering and owner colors.
- Open category and subcategory drawers and verify the contributing transactions.
- Confirm desktop at 1000px and above still renders the existing Recharts Sankey.
- Confirm the viewer remains read-only and stores no financial data in browser persistence.

## Builder Decisions

The builder may choose exact spacing, easing duration, ribbon gradients, icon mapping, and the compact overflow arrangement, provided the hierarchy, reconciliation, touch targets, existing FinTracka visual language, and no-overflow requirements remain intact. Search is local to the already-published flow; it does not call a server.

