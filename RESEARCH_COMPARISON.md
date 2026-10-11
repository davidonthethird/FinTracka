# Research Comparison

Verified facts below come from public first-party documentation. FinTracka decisions are independent design proposals.

## Tiller Money

- Verified: the Foundation Template includes Transactions, Categories, AutoCat, Monthly Budget, Yearly Budget, Accounts, Balances, Balance History, and Spending Trends. [Foundation Template](https://help.tiller.com/en/articles/3250724-what-is-the-tiller-foundation-template)
- Verified: AutoCat applies ordered rules using transaction filters and overrides. [AutoCat](https://help.tiller.com/en/articles/3792984-how-to-use-autocat-for-automatic-categorization)
- Verified: Tiller is currently advertised at $99/year after a trial. [Pricing](https://tiller.com/pricing/)
- Implement: spreadsheet-like register speed, user-owned categories, ordered rules, budgets, balances, and remote spreadsheet visibility.
- Improve: make SQLite authoritative; add idempotent sync checkpoints, reconciliation, tombstones, and explicit audit history.
- Postpone: AI suggestions and community-template extensibility.
- Omit: proprietary formulas, branding, icons, and add-in behavior.

## Actual Budget

- Verified: Actual is local-first and supports local-only desktop use. [Repository](https://github.com/actualbudget/actual)
- Verified: rules can match imported payee, account, category, date, notes, amount, and cleared state. [Rules](https://actualbudget.org/docs/budgeting/rules/)
- Verified: linked transfer halves are excluded from normal reporting semantics. [Transfers](https://actualbudget.org/docs/transactions/transfers/)
- Verified: its report dashboard includes cash flow, net worth, spending analysis, and customizable reports. [Reports](https://actualbudget.org/docs/reports/)
- Implement: fast account navigation, dense registers, transfer linkage, rules, envelope concepts, and calm UI hierarchy.
- Omit: multi-device synchronization, shared server, and full envelope-only product framing.

## Firefly III

- Verified: Firefly III is a self-hosted personal finance manager with budgets, categories, tags, rules, reports, and double-entry bookkeeping. [Repository](https://github.com/firefly-iii/firefly-iii)
- Verified: rules combine triggers and actions and may be applied to historical transactions. [Rules](https://docs.firefly-iii.org/how-to/firefly-iii/features/rules/)
- Implement: audit-minded transaction history, tags, rule previews, and clear financial reports.
- Omit: PHP deployment stack, public server administration, multi-user controls, and a complete double-entry engine.

## Data providers

- Plaid: Sandbox is free; `/transactions/sync` provides added, modified, and removed records using a cursor. Current Trial documentation allows 10 lifetime Production Items for eligible new US/Canada teams, while paid price lists require a production application. [Billing](https://plaid.com/docs/account/billing/), [Transactions](https://plaid.com/docs/api/products/transactions/)
- SimpleFIN: $1.50/month or $15/year plus tax, up to 25 institutions and 25 apps; daily updates, 90-day request windows, and institution-dependent history. [Pricing](https://beta-bridge.simplefin.org/), [Developer guide](https://beta-bridge.simplefin.org/info/developers)
- Teller: free development tier with up to 100 live enrollments; production Transactions is advertised at $0.30/enrollment/month and Balance at $0.10/call. Its sync guidance uses overlapping date windows and stable IDs. [Pricing](https://teller.io/), [Transactions](https://teller.io/docs/api/account/transactions)

## Decision

Implement Plaid Sandbox first because it supplies the strongest mutation semantics for validating the ledger. Evaluate Plaid Trial for live use only after coverage, pricing, FileVault, backup, and reconciliation gates. Keep SimpleFIN as the predictable-cost fallback and Teller as an unimplemented alternative.

