# FinTracka Project Specification

## Purpose

FinTracka is a local-first personal finance application for one macOS user. It imports read-only account and transaction data, preserves a verifiable local ledger, supports two distinct budgeting methods, and publishes read-only spreadsheet views. SQLite is authoritative; providers and spreadsheets are replicas or inputs.

## Success criteria

- Repeating any provider sync or file import does not duplicate canonical transactions.
- Provider changes never overwrite user categories, notes, tags, splits, or merchant edits.
- Confirmed owned-account transfers and credit-card payments contribute zero to income and expenses.
- Every amount is stored as integer minor units and every aggregate is exact to the cent.
- A statement that differs by one cent fails reconciliation.
- The dashboard binds only to `127.0.0.1`; secrets never enter SQLite, frontend storage, logs, screenshots, or Git.
- Google Sheets and Excel exports are deterministic, replace prior snapshots, and never become authoritative.

## Release 1 capabilities

- Synthetic data for three institutions, checking, savings, and credit cards.
- Accounts, balances, transaction search/filter/edit, splits, tags, and bulk categorization.
- Deterministic category rules with ordered first-match behavior and protected manual overrides.
- Transfer, duplicate, refund, reimbursement, and reversal review.
- Tracking budgets and envelope budgets as separate views over the same ledger.
- Overview, spending, cash-flow, merchant, budget, and balance-history reports.
- CSV import, reconciliation, Excel export, Google Sheets export, local backups, and daily launchd sync.
- Plaid Sandbox connection and incremental Transactions Sync. A live connection remains separately gated.

## Financial conventions

- `amount_minor > 0` is money entering an account; `< 0` is money leaving it.
- Account balances are positive magnitudes plus an `asset` or `liability` nature.
- UTC is used for instants; `America/New_York` derives the reporting date.
- Currency is ISO-4217. USD participates in combined totals; other currencies remain visible but excluded from combined reports.
- Provider removals are tombstones, never destructive deletes.
- Split children must sum exactly to their parent and replace the parent in reports.

## Budget semantics

- Tracking: monthly category target versus actual, with yearly rollups.
- Envelope: prior availability + allocations - spending + refunds. Overspending carries forward.
- Tracking and envelope totals are never mixed.

## Explicit exclusions

Multi-user accounts, public hosting, direct LAN access, investments, crypto, loan schedules, payment initiation, account/routing-number access, AI categorization, two-way spreadsheet edits, mobile apps, and arbitrary custom report builders.

## Approval boundaries

Synthetic fixtures and Plaid Sandbox are approved. Production credentials, live institutions, public networking, and payment-capable API products are not approved by this specification.

