# Database Design

## Storage rules

- SQLite is authoritative. Enable `foreign_keys=ON`, WAL, `busy_timeout=5000`, and synchronous `NORMAL`.
- Primary keys are UUIDv7 text. UTC timestamps use RFC 3339 text. Dates use ISO `YYYY-MM-DD`.
- Money is signed integer minor units. Currency is a three-letter uppercase code.
- Destructive provider changes create tombstones. User-requested erasure is a separate confirmed operation.

## Tables and constraints

### Connections

- `institutions(id, provider, external_id, name)` unique on `(provider, external_id)`.
- `provider_connections(id, provider, external_connection_id, institution_id, status, last_success_at, last_error_code, created_at, updated_at)` unique on `(provider, external_connection_id)`.
- `connection_secret_refs(connection_id, keychain_service, keychain_account)` contains references only.
- `provider_checkpoints(connection_id, cursor, updated_at)` one row per connection.

### Accounts

- `accounts(id, connection_id, provider_account_id, name, nickname, type, subtype, nature, mask, currency, status, include_overview, include_budget, include_net, include_export, created_at, updated_at)` unique on `(connection_id, provider_account_id)`.
- `account_balance_snapshots(id, account_id, observed_at, current_minor, available_minor, currency, source)` unique on `(account_id, observed_at, source)`.

### Transactions

- `transactions` stores normalized provider facts and separate user-owned fields: account, local date, UTC instant, amount, currency, raw/normalized description, merchant, pending/tombstone flags, user merchant, category, category source, notes, and timestamps.
- `transaction_external_ids(provider, connection_id, external_id, transaction_id, state)` unique on `(provider, connection_id, external_id)`.
- `transaction_provider_versions(transaction_id, observed_at, payload_hash, raw_json)` records provider mutations without secrets.
- `transaction_splits(id, parent_transaction_id, amount_minor, category_id, notes)`; service and deferred foreign-key checks enforce exact parent sum.
- `transfer_links(id, transaction_a_id, transaction_b_id, status, confidence, reason)` uses unique transaction membership indexes.
- `tags` and `transaction_tags` form the tag relation.

### Categories and budgets

- `category_groups` and `categories` support `income`, `expense`, and `transfer`, plus `ordinary`, `expense_offset`, `excluded`, and `income` reporting behaviors.
- `categorization_rules` stores priority, enabled state, JSON conditions, destination category, and timestamps. Lowest priority number wins.
- `rule_applications` records rule/transaction/result and preview versus applied state.
- `tracking_budget_targets(category_id, month, amount_minor, currency)` unique per category/month.
- `envelope_allocations(category_id, month, amount_minor, currency)` unique per category/month.
- `envelope_month_settings(month, starting_pool_minor, currency)` unique per month.

### Operations and audit

- Sync runs/items, import batches/rows, reconciliations/issues, export targets/runs, audit events, and schema migrations.
- Import batch file hashes prevent exact file replays; ambiguous cross-file duplicates remain review suggestions.
- Audit events contain actor, action, entity type/id, timestamp, and sanitized before/after JSON.

## Reporting invariants

- Split parents do not contribute to reports; children do.
- Confirmed transfer pairs do not contribute to income or expense.
- Tombstoned transactions are excluded by default and remain available to audit/reconciliation.
- Refund and reimbursement categories offset expenses rather than inflate income.
- Non-USD rows are excluded from combined USD totals.

