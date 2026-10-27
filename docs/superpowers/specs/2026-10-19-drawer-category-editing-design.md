# Drawer Category Editing Design

## Goal

Let the user recategorize a transaction directly from the Planning category drawer or Reports flow drawer, with the same audited learning behavior already available in the Transactions register.

## Interaction

- Both drawers show one three-position scope control above their transaction list:
  - `1×` — this transaction only (`one_time`)
  - `→` — this transaction and future merchant matches (`future`)
  - `↔` — matching past and future transactions (`past_and_future`)
- Each option exposes its full meaning through a native tooltip and an accessible label. The selected option is visually pressed.
- First-time use defaults to `one_time`. The last selection is stored under the non-sensitive browser preference key `fintracka-categorization-scope` and reused by Transactions, Planning, and Reports after navigation or application restart.
- Each drawer transaction has an Edit button. Activating it replaces the category text with a category selector and Cancel action. Choosing a different category saves immediately.
- Cash withdrawals always use `one_time`, regardless of the visible preference, because each withdrawal is unique.
- Successful saves announce the affected count and scope. When an undo identifier is returned, the drawer shows Undo.
- The open drawer, current chart selection, and page scroll position remain stable while data refreshes. If the edited transaction no longer belongs to the selected Planning category or Reports path, it disappears from the drawer after the refresh.
- Failures leave the editor open and show an accessible error; optimistic-concurrency conflicts tell the user to retry from refreshed data.

## Data and architecture

- Reuse `POST /api/v1/transactions/{transaction_id}/categorize` and `POST /api/v1/categorizations/{undo_id}/undo`; do not add a competing mutation path.
- Extend Planning category transaction rows and Reports flow entries with `category_id`, `updated_at`, and `is_cash_withdrawal`. These are existing non-secret ledger fields required by the mutation contract.
- Extract the scope type, preference parsing, scope labels, and segmented control from the Transactions page into a shared categorization module.
- Keep category-option loading in each owning page and pass the data plus save callback to the drawer. The drawer remains presentational apart from its row-editing state.
- Refresh the owning Planning or Reports read models only after a successful mutation or undo. Do not close and reopen the drawer.

## Accessibility and visual behavior

- The scope control uses real buttons with `aria-pressed`, descriptive `aria-label`, and `title` attributes; symbols are never the only accessible description.
- Edit, Cancel, selectors, status, and Undo are keyboard reachable inside the existing focus trap.
- The control stays compact on desktop and wraps above the transaction list on narrow drawers.
- Existing FinTracka colors, borders, typography, and focus styles are reused; no dependency is added.

## Out of scope

- Editing subcategories, spending owner, amount, date, notes, or split children from these drawers.
- Creating or renaming categories.
- Changing the existing rule-matching algorithm or audit schema.
- Storing transaction or credential data in browser storage.

## Acceptance criteria

1. A transaction can be recategorized from either drawer without visiting Transactions.
2. All three scopes send the exact existing API values and display their meanings on hover/focus.
3. The last selected scope survives reload and application restart; an absent or invalid preference safely resolves to `one_time`.
4. Withdrawal edits affect only that withdrawal.
5. Planning and Reports totals and drawer rows refresh after save or undo without closing the drawer or scrolling the background page.
6. Revision conflicts and network failures do not silently lose the edit.

