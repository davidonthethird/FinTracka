# Remote Flow Map and Transaction Alignment Design

## Goal

Make remote transaction amounts scan as one stable column and bring the local financial-flow report to the hosted viewer without horizontal chart scrolling.

## Transactions

Every transaction row reserves the same narrow owner-marker column, including rows with no spending owner. The amount occupies a fixed-width, right-aligned column with tabular numerals. The marker remains hidden when no owner applies, but its grid space remains.

## Reports

The published `cash_flow_paths.nodes` and `cash_flow_paths.links` remain the single source of truth.

- Desktop and tablet render the connected left-to-right financial flow using the existing Recharts Sankey pattern.
- Narrow screens render a zoomable flow wheel using nested Recharts pie rings: the inner ring represents expense groups and the outer ring represents final expense categories. The center shows the total outflow.
- A compact list beside or below the wheel shows every final category, amount, and percentage so small slices never hide information.
- Selecting a group focuses the wheel and list on that group, enlarging its categories. A breadcrumb/reset control returns to all spending.
- Selecting a final category opens the existing read-only category drawer with its transactions.
- Empty or incomplete flow data falls back to the existing category report rather than crashing or showing an empty chart.

The hosted viewer stays read-only and does not persist financial data in browser storage.

## Responsive behavior

The chart never creates horizontal page overflow. At 760px and above the Sankey is used. Below 760px the wheel is used. Normal vertical page scrolling remains available, but the chart needs no horizontal pan.

## Accessibility

All selectable nodes, slices, list rows, focus/reset controls, and category drill-downs use native buttons or keyboard-activatable SVG elements with meaningful labels. Color is supplemented by text, amounts, and percentages.
