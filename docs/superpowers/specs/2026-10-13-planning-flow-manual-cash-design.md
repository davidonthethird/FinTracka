# Planning Flow and Manual Cash Design

**Date:** 2026-10-13  
**Status:** Approved in conversation; awaiting review of this written specification

## Purpose

Replace FinTracka's basic Tracking Budget screen with a household planning view that compares usual spending, intended targets, and current-month actuals in one interactive flow. Add fully audited manual cash expenses and planned recurring income without mixing planned money with the actual ledger.

The feature is for David and Ariela. Spending can be viewed together or filtered by David, Ariela, or Shared. Income planning remains household-wide.

## Scope

This change includes:

- A standalone Tzedaka category and category group.
- Manual cash transactions entered from the Transactions page or Tzedaka detail view.
- Effective-dated planned income sources with Salary and Custom types.
- Effective-dated category spending targets with one-month overrides.
- A 1–12 completed-month historical average.
- A goal-versus-actual planning flow and category detail drawer.
- Spender filtering, monthly trends, target status, and surplus/shortfall reporting.
- Migration of existing Giving data and existing Tracking Budget targets.

Envelope Budget remains a separate feature and its calculations do not mix with planning totals.

## Financial rules

### Tzedaka

The existing Giving category is renamed Tzedaka while retaining its stable ID. It is moved from Lifestyle into a new standalone Tzedaka group. Existing transaction assignments, rules, exports, and audit relationships therefore continue to reference the same category.

For each month, the Tzedaka minimum target is 10% of the effective amounts of all planned income sources whose type is Salary. Custom income sources do not contribute. The calculation uses integer minor units and rounds upward when 10% would contain a fraction of a cent:

```text
tzedaka_minimum_minor = ceil(planned_salary_minor / 10)
```

The effective target is the greater of the calculated minimum and the user-entered target. A target below the minimum is rejected by the service. A user may set a higher target.

All actual transactions categorized as Tzedaka, including manual cash transactions, contribute to Tzedaka actual spending.

### Manual cash transactions

A manual cash entry requires:

- Title.
- Positive amount entered by the user and stored as a negative ledger amount.
- Expense category.

Its date defaults to today and its spender defaults to Shared. Both are editable. Currency is USD for release 1.

Manual cash uses an app-owned internal provider connection and account. It requires no secret and has no observed balance. Entries are ordinary canonical transactions, so they participate in reports, planning actuals, historical averages, ownership totals, exports, and searches. The internal account is excluded from net position and balance totals because FinTracka does not know the amount of physical cash held.

Manual cash entries may be edited. Deletion tombstones the entry, removes it from normal totals and exports, and retains audit history. Plaid-owned transactions cannot be deleted through this manual-entry operation.

Manual cash is independent of imported bank withdrawals. It may represent existing physical cash or cash paid directly from salary.

### Imported cash withdrawals

Detected ATM and cash withdrawals default to Other. Detection uses normalized provider transaction detail when available and conservative description matching as a fallback. A detected withdrawal is permanently ineligible for rule learning. Changing its category always applies only to that transaction, regardless of the correction scope selected elsewhere in the interface.

The withdrawal itself remains an expense. Manual cash entries do not split, replace, link to, or offset it.

### Planned income

Planned income is planning-only. It never creates ledger transactions, changes account balances, or appears as actual income.

Each source contains:

- Stable ID.
- User-written title.
- Type: Salary or Custom.
- Monthly amount in integer minor units.
- Effective starting month.
- Active state.

Editing a recurring source creates a new effective-dated version beginning with the selected month. Prior months keep their original title, type, amount, and state. A separate one-month override changes only one month. Removing a source creates an inactive version rather than destroying history.

### Spending targets

Each expense category may have an effective-dated recurring target and a one-month override. A recurring edit starts with the selected month and preserves earlier values. A month override wins over the recurring value for that month.

Existing `tracking_budget_targets` rows migrate as explicit one-month overrides. After migration, the new planning service becomes authoritative for tracking targets. Envelope allocations remain independent.

Targets are household values. Filtering actuals and averages by spender does not silently rewrite targets. The interface labels targets as household targets when a person filter is active.

Total targets may exceed planned income. Saving is allowed, but the plan prominently reports the resulting shortfall. When planned income exceeds targets, it reports the surplus.

### Historical averages and actuals

The average window is an integer from 1 through 12. For a selected planning month, the average uses that many complete calendar months immediately before the selected month. The selected month's partial activity is never included in its historical average.

Every month in the window is included in the denominator, including months with zero activity. Ordinary expenses increase spending, expense offsets and refunds reduce it, confirmed transfers are excluded, tombstoned and pending transactions are excluded, and manual cash is included. Calculations use the account's budget-inclusion flag and USD-only reporting conventions already used by Tracking Budget.

When a spender filter is active, averages, actuals, trends, and transaction drill-downs include only transactions whose effective spender matches the filter. Everyone includes David, Ariela, and Shared.

Actual spending is month-to-date ledger activity for the selected month. Remaining is target minus actual. A negative remaining value is displayed as overspending.

## Data design

A numbered migration adds these concepts:

- Effective-dated planned-income source versions.
- Planned-income month overrides.
- Effective-dated recurring category targets.
- Category target month overrides.
- A durable marker that a provider transaction is a cash withdrawal and is ineligible for learned rules.
- The app-owned Manual cash institution, provider connection, and account.

Effective-dated rows use a unique `(entity_id, effective_month)` key. Month overrides use a unique `(entity_id, month)` key. Amounts are nonnegative integer minor units, months use `YYYY-MM`, currencies use ISO-4217 shapes, and income types are restricted to Salary or Custom.

The migration renames and moves Giving without changing its category ID. It copies existing Tracking Budget month values into target overrides before the old table is retired from active use. The migration must be atomic and safe to rerun through the existing migration registry.

All planning and manual-cash mutations append audit events. User-visible records use optimistic `updated_at` conflict checks.

## Service and API design

The planning service owns effective-value resolution, average calculations, Tzedaka minimum enforcement, surplus/shortfall calculation, and category detail assembly. Ledger reporting helpers remain the source for actual transaction activity.

The public API remains under `/api/v1` and adds:

- `GET /planning/{month}` with `average_months` and optional `spending_owner` filters.
- Planned-income source create, update, deactivate, and month-override mutations.
- Category recurring-target and month-override mutations.
- `POST /transactions/manual-cash` for creation.
- Manual-cash edit through the transaction mutation flow.
- `DELETE /transactions/{id}` restricted to app-owned manual cash entries.

The planning response contains:

- Effective income sources and planned-income total.
- Salary subtotal and calculated Tzedaka minimum.
- One row per active expense category with historical average, target, actual, remaining, and status.
- Planned target total and surplus or shortfall.
- Monthly trend points and contributing transaction IDs needed by the detail view.

All mutation models reject unexpected fields. Session cookies, CSRF protection, Host and Origin checks, exact-cent validation, short write transactions, and audit rules match existing APIs.

## Interface design

### Planning page

Tracking Budget is renamed Planning. The page contains:

- Selected month.
- Everyone, David, Ariela, and Shared filter.
- A 1–12 month average-window slider.
- Editable planned-income sources with title, Salary or Custom type, and effective monthly amount.
- Central planned-income total.
- Category outflows displaying historical average, target, and actual spent so far at the same time.
- Remaining or overspent status for every category.
- Visible plan surplus or shortfall.
- A clearly labeled 10% Salary minimum on Tzedaka.

The flow uses the existing calm-instrument visual language rather than copying the reference application's branding or assets. Historical average is the subdued background measure, target is the main planned stream, and current actual is the filled progress measure. Exact figures and text labels accompany every color encoding.

If there is no planned income, the category planning tools still work and the page explains why the income flow is empty. If there is insufficient history, the page uses available ledger months but retains the selected window's zero months in the denominator.

### Category detail drawer

Selecting a category opens a keyboard-accessible side drawer containing:

- Historical average.
- Effective target.
- Current-month actual.
- Remaining or overspent amount.
- Monthly spending trend over the same selected window.
- Recurring target editor and one-month override action.
- Current-month contributing transactions.

The active spender filter carries into the drawer. Tzedaka adds a prominent Add cash Tzedaka action that preselects the category.

### Transactions page

Transactions gains an Add cash spending action. Its compact dialog requires title, amount, and category and defaults date to today and spender to Shared. Manual rows carry a Manual cash label plus Edit and Delete actions. Delete requires confirmation.

Detected withdrawal rows explain that category changes apply only once. Their categorization controls never offer retroactive or future learning.

### Responsive and accessible behavior

At the desktop acceptance viewport, income, central plan, and category outflows appear together. Narrow layouts change to a vertical income-to-plan-to-category sequence instead of compressing the chart. The average slider has keyboard controls and a numeric label. Drawers trap focus, restore focus on close, close with Escape, and expose status through text as well as color. Existing dark-mode tokens and tabular numerals remain in use.

## Overview and export behavior

Manual cash contributes to expense totals but cannot be reconciled to Plaid balance snapshots. Overview therefore shows it separately as off-bank cash spending and does not imply that it explains the change between observed bank balances.

Spreadsheet snapshots include manual cash transactions like other exported ledger rows and identify their account/source. Planning exports include effective planned income, average-window metadata, targets, actuals, remaining amounts, and the calculated Tzedaka minimum. Repeated exports remain deterministic.

## Failure behavior

- Invalid dates, months, owners, categories, income types, and amounts return validation errors without partial writes.
- A Tzedaka target below the calculated minimum returns the minimum required value.
- Concurrent edits return the existing optimistic-conflict response.
- Deleting a non-manual transaction through the manual deletion route is forbidden.
- If migration or a planning write fails, its SQLite transaction rolls back completely.
- Empty plans, missing history, and zero targets render explicit states rather than broken flows or division errors.

## Verification

Automated tests use synthetic data and cover:

- Giving-to-Tzedaka migration while preserving IDs, assignments, and rules.
- Salary-only Tzedaka calculation, Custom exclusion, upward-cent rounding, and higher user targets.
- Rejection of a Tzedaka target below the minimum.
- Recurring income and target versions, preserved past months, one-month overrides, and deactivation.
- One-through-twelve-month averages with zero-spending months.
- Refunds, transfers, pending and tombstoned entries, manual cash, and spender filters.
- Manual cash creation, editing, soft deletion, audit history, search, reports, and exports.
- Rejection of manual deletion for provider-owned transactions.
- Withdrawal detection and guaranteed one-time categorization.
- Plan surplus and shortfall.
- Category trends and contributing transaction selection.
- API CSRF, Host, Origin, strict-field, and conflict behavior.
- Browser flows for planned income, average slider, target editing, category drawer, cash entry, Tzedaka quick entry, and responsive/keyboard behavior.

Before applying the migration to the live ledger, FinTracka creates and verifies a local backup. After migration it verifies SQLite integrity, unchanged provider-transaction counts, migrated Tzedaka assignments, planning calculations, and a restore drill. No live financial values or credentials enter automated fixtures, logs, screenshots, Git, or GitHub Actions.

## Acceptance criteria

- Existing Giving transactions and rules appear as Tzedaka without losing identity or audit history.
- Tzedaka's target is never lower than 10% of effective planned Salary income.
- Custom planned income never changes the Tzedaka minimum or actual ledger totals.
- Historical averages use the chosen completed-month window and include zero months.
- Manual cash is visible and counted everywhere expenses are reported while remaining separate from bank balances.
- Editing a detected withdrawal never changes another withdrawal or creates a learning rule.
- Recurring changes affect the selected month forward without rewriting history; overrides affect one month only.
- The flow shows average, target, actual, and remaining simultaneously.
- Selecting a category opens its trend and contributing transactions.
- Spending can be viewed for Everyone, David, Ariela, or Shared.
- Targets may exceed income, with an explicit shortfall instead of a blocked save.
- All mutations are audited, exact to the cent, and reversible where specified.

## Explicit exclusions

- Manual tracking of the amount of physical cash on hand.
- Linking manual cash entries to bank withdrawals.
- Treating planned income as actual income.
- Automatically sharing household targets between the Planning and Envelope Budget systems.
- Forecasting future Plaid transactions.
- Multi-currency combined planning totals.
