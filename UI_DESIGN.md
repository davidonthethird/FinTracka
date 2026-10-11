# UI Design

## Direction

FinTracka should feel like a calm financial instrument: dense enough for real work, visually quiet, and explicit about the source and freshness of every number.

- Typography: Avenir Next/system sans with tabular numerals.
- Light colors: paper `#F5F7F8`, ink `#142638`, teal `#147D70`, amber `#A96518`, red `#A83C43`, slate `#657383`.
- Dark mode is the same semantic token set, not a separate layout.
- Borders express hierarchy; avoid gradients, decorative shadows, animated entrances, and walls of identical cards.
- The distinctive overview element is a cash-movement strip: opening cash → income → spending → transfers → closing cash.

## Shell wireframe

```text
┌──────────────┬─────────────────────────────────────────────────────┐
│ FinTracka    │ Page title                         Sync status      │
│ Overview     ├─────────────────────────────────────────────────────┤
│ Accounts     │ Filters / period / primary action                  │
│ Transactions │                                                     │
│ Budgets      │ Main content                                        │
│ Reports      │                                                     │
│ Rules        │                                                     │
│ Connections  │                                                     │
│ Settings     │                                                     │
└──────────────┴─────────────────────────────────────────────────────┘
```

At 1440×900 the sidebar is pinned. Below 900 px it becomes a drawer; data tables retain horizontal scrolling rather than hiding financial fields.

## Pages

- Overview: cash/liability/net summaries, movement strip, monthly income/expense, budget status, category spending, trend chart, recent transactions, and connection health.
- Accounts: institution groups, balances and freshness, nickname/type/mask, inclusion toggles, and balance-history drawer.
- Transactions: sticky filters, search, sortable register, multi-select, bulk category/tag, split dialog, and duplicate/transfer review.
- Tracking Budget: month selector, target/actual/variance by group/category, yearly rollup link.
- Envelope Budget: available-to-assign, allocations, activity, available balance, and overspending carried forward.
- Reports: spending by month/category/merchant, income versus expense, cash flow, budget actual, balance history, and yearly comparison.
- Rules: ordered list, conditions summary, destination, enabled state, match preview, and explicit historical reprocess confirmation.
- Connections: provider/item health, included accounts, last success, repair, sync, and disconnect.
- Settings: theme, schedule status, export targets, backup/recovery, data paths, and live-data readiness.

## States and copy

- Empty pages state the next useful action, such as “Load synthetic data” or “Import a CSV.”
- Errors name the failed operation and recovery action; they never expose raw provider text.
- Pending transactions and stale balances are visually labeled, never conveyed by color alone.
- Destructive or external actions require explicit confirmation; ordinary categorization does not.

## Accessibility

Visible keyboard focus, semantic landmarks/tables, 4.5:1 text contrast, non-color status labels, reduced-motion support, 44 px primary targets, and logical focus return after dialogs.

