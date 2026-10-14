# Planning Accuracy, Savings, and Subcategories Design

**Date:** 2026-10-13  
**Status:** Approved in conversation; awaiting review of this written specification

## Purpose

Make FinTracka understandable at a glance without weakening ledger accuracy. Planning must distinguish missing history from real zero-spending months, show whether household spending is on track, and size its category flows proportionally. Internal transfers and credit-card payments must disappear from ordinary spending views. A separate Savings page must show savings progress and manually valued assets. Transactions must support automatically learned, editable subcategories.

This design extends the existing shared SQLite ledger and reporting services. It does not introduce double-entry accounting, cloud storage, AI categorization, or additional Plaid products.

## Product decisions

- Keep the existing approximately 90 days of Plaid history. Do not disconnect or recreate current Plaid Items to request older data.
- Preserve imported financial history locally indefinitely. FinTracka never ages records out merely because Plaid no longer returns them.
- A requested historical window reports how many complete months are actually usable.
- Current daily pace drives forecasts until six complete prior months exist; historical within-month timing is used afterward.
- Category lane size is based on its target, falling back to historical average when no target exists, with a minimum accessible size.
- Transfers and credit-card payments are hidden by default but remain available through an explicit audit filter.
- Savings remains separate from Planning. Investment returns are not manually modeled because they appear in connected financial activity.
- Subcategories use deterministic local rules, not AI or an external categorization service.

## Historical coverage and averages

### Coverage

FinTracka records the earliest date from which a provider connection is expected to have complete transaction coverage. Existing Plaid connections are initialized from their connection date minus the default 90-day requested period, adjusted earlier if an imported transaction predates that boundary. Future providers may supply a more precise boundary through the provider-neutral normalized connection status.

Only complete calendar months after the effective coverage boundary are eligible for historical averages. The selected month is never included. For a household view, a month is usable when every active, budget-included provider connection represented in that view has coverage for the full month. App-owned manual-cash data does not shorten provider coverage.

The response includes:

- Requested window length.
- Usable completed-month count.
- Earliest usable month.
- The exact months used.

If a 12-month window contains only August and September as complete covered months, the denominator is two and the interface says `2 of 12 months available`. A month between the earliest and latest usable months counts as zero when it contains no matching activity. Leading unavailable months never count as zero.

All existing financial conventions remain: pending, tombstoned, confirmed transfers, excluded categories, and non-USD activity do not contribute; refunds and expense offsets reduce spending; manual cash and split children contribute normally.

### Local retention

SQLite remains authoritative. Provider removals remain tombstones for audit, but FinTracka must distinguish a provider correction/removal from data aging. Previously posted historical transactions are not physically deleted. No cleanup process removes old canonical transactions, provider versions, aliases, splits, transfer links, subcategory assignments, or audits.

## Planning calculations

### Category status

For each category:

```text
remaining_minor = target_minor - actual_minor
percent_used = actual_minor / target_minor, when target_minor > 0
percent_remaining = remaining_minor / target_minor, when target_minor > 0
```

When the target is zero:

- Zero actual spending is neutral and labeled `No target`.
- Positive spending is amber and labeled `$X unplanned`.
- The category is never labeled green, left, on track, or over by a percentage.

Refund-driven negative actuals are displayed explicitly and never create a misleading percentage.

### Forecast

Forecasts apply only to the current calendar month. Past months show their final actual result; future months show no forecast.

With fewer than six usable historical months, projection uses current calendar pace:

```text
projected_minor = actual_minor * days_in_month / elapsed_days
```

With at least six usable historical months, FinTracka calculates, for each prior month, the fraction of that month's final category spending that had occurred by the equivalent day. The median usable fraction is the historical pacing factor:

```text
projected_minor = actual_minor / historical_pacing_factor
```

Months with nonpositive final spending or an unusable pacing fraction are omitted. If no valid factor remains, FinTracka falls back to calendar pace. Integer minor-unit rounding is deterministic.

Overall projection is computed from category projections, not by projecting a pre-rounded aggregate. Overall status is:

- Green `On track`: projected spending below 90% of target.
- Amber `Close to target`: projected spending from 90% through 100% of target.
- Red `Projected over`: projected spending above target.
- Amber `Unplanned spending`: spending exists while the total target is zero or unplanned categories materially affect the result.
- Gray `No plan yet`: no target and no spending.

Exact dollars and percentages accompany every status; color is never the sole signal.

### Planning presentation

The summary area prioritizes:

- Monthly spending target.
- Spent so far and percentage used.
- Remaining and percentage left, or overspent and percentage over.
- Projected month-end spending.
- Projected surplus or shortfall.
- Days elapsed in the selected month.
- A plain-language overall status.

Planned income and the Tzedaka minimum remain visible but secondary. Savings does not enter the Planning headline.

Each category lane simultaneously shows historical average, target, actual, remaining or unplanned amount, percentage, and forecast. Its visual allocation uses the target as the primary weight. A category without a target uses its historical average. A minimum lane size preserves readability and keyboard access; larger values receive proportionally larger lanes above that minimum. Actual spending fills the planned lane and may visibly extend beyond it when overspent.

The existing category drawer adds forecast, percentage, coverage count, subcategory breakdown, and the existing monthly trend and transaction drill-down.

## Transfers and credit-card payments

Transactions whose effective category type is `transfer`, including `Transfer` and `Credit card payment`, are:

- Excluded from income, spending, Planning, and ordinary reports.
- Hidden from the Transactions register by default.
- Retained in SQLite, audit history, reconciliation, exports where explicitly configured, and transfer review.
- Available in Transactions through an `Include transfers and card payments` filter.

Both sides may remain independently provider-categorized or be joined by a confirmed transfer link. Hiding does not depend on successful pairing, so an obvious credit-card payment does not pollute the ordinary register while awaiting confirmation.

Transfers into or out of an included savings account appear on the Savings page as contributions or withdrawals. They remain excluded from spending and income everywhere else.

## Subcategories

### Data model

A numbered migration adds:

- `subcategories`: stable ID, parent category ID, name, archived state, sort order, timestamps, and a unique active name within its parent category.
- `transaction_subcategory_rules`: normalized merchant match, parent category, subcategory, priority, enabled state, origin (`built_in` or `user`), timestamps, and audit identity.
- Provider-owned proposed subcategory and user-owned effective subcategory fields on canonical transactions, kept separate so sync cannot overwrite user choices.

A transaction may have no subcategory. A selected subcategory must belong to the transaction's effective parent category. Changing a parent category clears an incompatible subcategory unless a matching deterministic rule supplies a valid replacement.

### Automatic selection

Subcategory assignment is deterministic and local, in this order:

1. Enabled user-learned exact normalized-merchant rule.
2. Enabled built-in merchant rule.
3. Mapping from Plaid's detailed personal-finance category.
4. The parent's `General` subcategory when present, otherwise no subcategory.

Normalization reuses the existing merchant/description normalization behavior. Rules do not use amounts, account masks, owner names, or remote services. Cash withdrawals remain ineligible for future or retroactive learning.

The seed taxonomy includes broad coverage for Shopping, Food, Auto, Housing, Utilities, Healthcare, Insurance, Fun, Travel, Education, Children/family, Personal care, Subscriptions, Taxes, Fees, Tzedaka, and other existing expense parents. Examples include Lowe's to `Shopping / Home improvement` and Macy's to `Shopping / Clothing`. Built-in assignments are proposals that a user correction can always override.

### Editing and learning

Transaction editing displays parent category and relevant subcategory. The user can create a custom subcategory without leaving the editor. A correction supports:

- This transaction only.
- Matching future transactions.
- Existing and future matching transactions.

Existing-and-future is the default only when a normalized merchant is present and the record is not a detected cash withdrawal. Historical reprocessing preserves manual choices and updates only eligible transactions. Every assignment, custom subcategory, rule, and reprocessing action is audited.

Reports continue to total by parent category and gain optional subcategory breakdowns. Planning category detail shows its subcategory composition without changing the parent target model.

## Savings

### Included data

The Savings page includes:

- Plaid-connected accounts whose subtype is savings or which the user explicitly marks for Savings.
- Manual savings, investments, and other assets.
- David, Ariela, or Shared ownership.
- Current connected balances and balance history.
- Manual asset valuations.
- Monthly contributions and withdrawals.
- Recent savings activity.
- Totals for cash savings, investments, other assets, and combined saved assets.

Investment-return projections and manual monthly-return fields are explicitly excluded. Connected interest, dividends, and other statement activity remain visible as actual account activity.

### Manual assets

A numbered migration adds a small `manual_assets` table with stable ID, title, kind (`savings`, `investment`, or `other`), owner, current USD value, optional as-of date, active state, timestamps, and audits. Values are nonnegative integer minor units. Editing creates a new audited value; deactivation preserves history. Manual assets contribute to Savings totals and net position but never to Planning income or spending.

### Savings activity

For connected savings accounts:

- Positive transfer activity is a contribution.
- Negative transfer activity is a withdrawal.
- Interest and other non-transfer credits are displayed as account earnings/activity rather than planned income.
- Ordinary expenses directly charged to savings remain ordinary expenses in reports.

The page does not infer gains for manually valued assets. It shows the latest valuation and its as-of date.

## Service and API design

Existing services remain authoritative for ledger entries, ownership, exact money, audits, and optimistic conflicts. New logic is isolated into coverage, subcategory, and savings services rather than duplicated in route handlers.

The API adds or extends:

- Planning responses with coverage, percentage, projection, and overall-status fields.
- Transaction list query `include_transfers=false` by default.
- Transaction responses and mutations with subcategory identity.
- Subcategory list/create/update endpoints and categorization scope support.
- Savings summary, activity, balance-history, and manual-asset endpoints.
- Account editing with explicit Savings inclusion.

All mutations reject unexpected fields, require session and CSRF controls, use optimistic `updated_at` checks, and append audit events. List ordering is deterministic. No endpoint returns Plaid tokens, account masks beyond existing sanitized behavior, or raw provider payloads.

## Interface design

### Planning

The page keeps the established calm financial-instrument aesthetic. Green, amber, red, and gray status tokens are consistent across the headline, category lanes, and drawer. Text, exact values, icons, and percentages duplicate color meaning. Variable lanes retain a minimum pointer and keyboard target. At narrow widths, proportional flow becomes a readable stacked list without losing metrics.

### Transactions

The sticky filters add the transfer/payment visibility control and subcategory filter. Category editing immediately narrows the subcategory control to the selected parent. Creating a custom subcategory and choosing learning scope happen in the same compact flow.

### Savings

Savings becomes a primary navigation destination. Its overview leads with combined total and ownership filter, followed by connected savings balances, contribution/withdrawal trend, manual assets, and recent activity. It does not resemble a spending budget and does not feed the Planning summary.

### Accessibility

All percentage and forecast information has textual equivalents. Variable-size lanes preserve logical DOM order. Dialogs and drawers trap and restore focus, Escape closes overlays, status changes use appropriate live regions, and charts have equivalent lists or tables for screen readers.

## Migration and live-data safety

Before migration, FinTracka creates and integrity-checks a local backup. Migration is additive and does not rewrite canonical transaction amounts, provider IDs, user categories, transfer links, or account balances. Existing connections receive an inferred 90-day coverage boundary without reconnecting or calling Plaid.

After migration, verify transaction, account, connection, category, rule, split, and transfer counts; stable IDs; report totals; SQLite integrity; backup restore; and absence of secrets. Existing user changes outside this feature remain untouched.

## Verification

Synthetic tests cover:

- Leading unavailable months excluded from averages.
- Interior zero-spending months included.
- Partial months excluded and coverage counts exposed.
- Calendar forecast below six months, historical pacing at six or more, and deterministic fallback.
- Zero-target categories with and without spending.
- Percentage-left, percentage-over, refunds, and overall status boundaries.
- Transfers and credit-card payments hidden by default but recoverable by filter.
- Savings transfers shown as contributions/withdrawals without entering income or spending.
- Subcategory parent constraints, built-in mapping, user-rule precedence, three correction scopes, custom creation, reprocessing, withdrawal exclusion, and user-field preservation during sync.
- Manual asset creation, editing, deactivation, ownership, audit, totals, and Planning isolation.
- API validation, optimistic conflicts, CSRF, hostile Host/Origin, and secret absence.
- Spreadsheet export compatibility and formula escaping for new user-written values.
- Browser coverage for the Planning headline and lanes, coverage labels, category drawer, hidden-transfer filter, subcategory correction, Savings views, manual assets, dark mode, and keyboard navigation.

## Acceptance criteria

- A zero target never appears green or reports a percentage over target; spending is labeled unplanned.
- Missing leading history never reduces an average, while observed empty interior months count as zero.
- The interface states exactly how many requested months were available.
- Forecast, percentage, and overall status are understandable without relying on color.
- Category lane sizes materially reflect planned allocation while remaining usable at small values.
- Transfers and card payments are absent from ordinary Transactions and Planning but remain auditable.
- Savings transfers appear as savings activity and never as spending or income.
- Connected savings balances and manually valued assets remain separate but total correctly.
- Parent categories and subcategories remain consistent, editable, deterministic, and persistent across sync.
- Correcting a merchant can update one transaction, future transactions, or eligible history and future transactions.
- All existing financial data remains intact, exact to the cent, local, audited, and backed up before live migration.

## Explicit exclusions

- Reconnecting existing Plaid Items for more than the current 90-day history.
- Plaid Investments, Liabilities, Auth, or payment products.
- AI or cloud-based categorization.
- Double-entry accounting.
- Automatic valuation or projected growth for manual investments.
- Savings goals, retirement simulations, tax projections, or exchange-rate conversion.
- Treating savings contributions as expenses or Planning income.
