CREATE TABLE institutions (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(provider, external_id)
);

CREATE TABLE provider_connections (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    provider TEXT NOT NULL,
    external_connection_id TEXT NOT NULL,
    institution_id TEXT REFERENCES institutions(id),
    status TEXT NOT NULL CHECK(status IN ('active', 'repair', 'revoked', 'disabled')),
    last_success_at TEXT,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider, external_connection_id)
);

CREATE TABLE connection_secret_refs (
    connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
    keychain_service TEXT NOT NULL,
    keychain_account TEXT NOT NULL
);

CREATE TABLE provider_checkpoints (
    connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
    cursor TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE accounts (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    connection_id TEXT NOT NULL REFERENCES provider_connections(id),
    provider_account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    nickname TEXT,
    type TEXT NOT NULL,
    subtype TEXT,
    nature TEXT NOT NULL CHECK(nature IN ('asset', 'liability')),
    mask TEXT,
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed', 'tombstoned')),
    include_overview INTEGER NOT NULL DEFAULT 1 CHECK(include_overview IN (0, 1)),
    include_budget INTEGER NOT NULL DEFAULT 1 CHECK(include_budget IN (0, 1)),
    include_net INTEGER NOT NULL DEFAULT 1 CHECK(include_net IN (0, 1)),
    include_export INTEGER NOT NULL DEFAULT 1 CHECK(include_export IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(connection_id, provider_account_id)
);

CREATE TABLE account_balance_snapshots (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    observed_at TEXT NOT NULL,
    current_minor INTEGER NOT NULL CHECK(current_minor >= 0),
    available_minor INTEGER CHECK(available_minor IS NULL OR available_minor >= 0),
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    source TEXT NOT NULL,
    UNIQUE(account_id, observed_at, source)
);

CREATE TABLE category_groups (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE categories (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    group_id TEXT REFERENCES category_groups(id),
    name TEXT NOT NULL UNIQUE,
    category_type TEXT NOT NULL CHECK(category_type IN ('income', 'expense', 'transfer')),
    reporting_behavior TEXT NOT NULL CHECK(reporting_behavior IN ('ordinary', 'expense_offset', 'excluded', 'income')),
    sort_order INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE transactions (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    local_date TEXT NOT NULL CHECK(local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    authorized_at TEXT,
    posted_at TEXT,
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    provider_description TEXT NOT NULL,
    provider_merchant TEXT,
    pending INTEGER NOT NULL DEFAULT 0 CHECK(pending IN (0, 1)),
    tombstoned INTEGER NOT NULL DEFAULT 0 CHECK(tombstoned IN (0, 1)),
    user_merchant TEXT,
    category_id TEXT REFERENCES categories(id),
    category_source TEXT CHECK(category_source IN ('manual', 'rule', 'provider') OR category_source IS NULL),
    notes TEXT,
    has_splits INTEGER NOT NULL DEFAULT 0 CHECK(has_splits IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE transaction_external_ids (
    provider TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES provider_connections(id),
    external_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    state TEXT NOT NULL CHECK(state IN ('pending', 'posted', 'active', 'removed')),
    PRIMARY KEY(provider, connection_id, external_id)
);
CREATE INDEX transaction_external_ids_transaction_idx ON transaction_external_ids(transaction_id);

CREATE TABLE transaction_provider_versions (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    observed_at TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    sanitized_json TEXT,
    UNIQUE(transaction_id, payload_hash)
);

CREATE TABLE transaction_splits (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    parent_transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    amount_minor INTEGER NOT NULL CHECK(amount_minor != 0),
    category_id TEXT REFERENCES categories(id),
    notes TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE transfer_links (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    transaction_a_id TEXT NOT NULL REFERENCES transactions(id),
    transaction_b_id TEXT NOT NULL REFERENCES transactions(id),
    status TEXT NOT NULL CHECK(status IN ('suggested', 'confirmed', 'rejected')),
    confidence TEXT NOT NULL CHECK(confidence IN ('low', 'medium', 'high')),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(transaction_a_id < transaction_b_id),
    UNIQUE(transaction_a_id, transaction_b_id)
);
CREATE UNIQUE INDEX confirmed_transfer_a_idx ON transfer_links(transaction_a_id) WHERE status = 'confirmed';
CREATE UNIQUE INDEX confirmed_transfer_b_idx ON transfer_links(transaction_b_id) WHERE status = 'confirmed';

CREATE TABLE tags (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE TABLE transaction_tags (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(transaction_id, tag_id)
);

CREATE TABLE categorization_rules (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    name TEXT NOT NULL,
    priority INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    conditions_json TEXT NOT NULL CHECK(json_valid(conditions_json)),
    category_id TEXT NOT NULL REFERENCES categories(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(priority)
);
CREATE TABLE rule_applications (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    rule_id TEXT NOT NULL REFERENCES categorization_rules(id),
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    result TEXT NOT NULL CHECK(result IN ('preview', 'applied', 'skipped')),
    applied_at TEXT NOT NULL
);

CREATE TABLE tracking_budget_targets (
    category_id TEXT NOT NULL REFERENCES categories(id),
    month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    PRIMARY KEY(category_id, month)
);
CREATE TABLE envelope_allocations (
    category_id TEXT NOT NULL REFERENCES categories(id),
    month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    PRIMARY KEY(category_id, month)
);
CREATE TABLE envelope_month_settings (
    month TEXT PRIMARY KEY CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    starting_pool_minor INTEGER NOT NULL,
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency))
);

CREATE TABLE sync_runs (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'partial', 'failed', 'interrupted')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_code TEXT
);
CREATE TABLE sync_run_items (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES provider_connections(id),
    status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'interrupted')),
    added_count INTEGER NOT NULL DEFAULT 0 CHECK(added_count >= 0),
    modified_count INTEGER NOT NULL DEFAULT 0 CHECK(modified_count >= 0),
    removed_count INTEGER NOT NULL DEFAULT 0 CHECK(removed_count >= 0),
    error_code TEXT
);
CREATE TABLE import_batches (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    file_hash TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('previewed', 'committed', 'failed', 'reverted')),
    created_at TEXT NOT NULL,
    committed_at TEXT
);
CREATE TABLE import_rows (
    batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL CHECK(row_index >= 1),
    transaction_id TEXT REFERENCES transactions(id),
    row_hash TEXT NOT NULL,
    PRIMARY KEY(batch_id, row_index)
);
CREATE TABLE reconciliations (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    opening_minor INTEGER NOT NULL,
    closing_minor INTEGER NOT NULL,
    cleared_cutoff TEXT NOT NULL,
    difference_minor INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('balanced', 'unbalanced')),
    created_at TEXT NOT NULL
);
CREATE TABLE reconciliation_issues (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
    issue_type TEXT NOT NULL CHECK(issue_type IN ('missing', 'duplicate', 'uncleared', 'balance_difference')),
    transaction_id TEXT REFERENCES transactions(id),
    detail TEXT NOT NULL
);
CREATE TABLE export_targets (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    target_type TEXT NOT NULL CHECK(target_type IN ('excel', 'google_sheets')),
    destination_ref TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE export_runs (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    target_id TEXT NOT NULL REFERENCES export_targets(id),
    status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'interrupted')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_code TEXT
);
CREATE TABLE audit_events (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
    after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json))
);
CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, occurred_at);
CREATE TABLE jobs (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error_code TEXT
);
