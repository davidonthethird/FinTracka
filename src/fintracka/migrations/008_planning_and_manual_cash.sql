ALTER TABLE transactions ADD COLUMN is_cash_withdrawal INTEGER NOT NULL DEFAULT 0
    CHECK(is_cash_withdrawal IN (0, 1));

CREATE TABLE planning_income_sources (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE planning_income_versions (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    source_id TEXT NOT NULL REFERENCES planning_income_sources(id) ON DELETE CASCADE,
    effective_month TEXT NOT NULL CHECK(effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
    income_type TEXT NOT NULL CHECK(income_type IN ('Salary', 'Custom')),
    amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_id, effective_month)
);
CREATE INDEX planning_income_versions_effective_idx
ON planning_income_versions(source_id, effective_month DESC);

CREATE TABLE planning_income_overrides (
    source_id TEXT NOT NULL REFERENCES planning_income_sources(id) ON DELETE CASCADE,
    month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(source_id, month)
);

CREATE TABLE planning_target_versions (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    category_id TEXT NOT NULL REFERENCES categories(id),
    effective_month TEXT NOT NULL CHECK(effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(category_id, effective_month)
);
CREATE INDEX planning_target_versions_effective_idx
ON planning_target_versions(category_id, effective_month DESC);

CREATE TABLE planning_target_overrides (
    category_id TEXT NOT NULL REFERENCES categories(id),
    month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(category_id, month)
);

INSERT OR IGNORE INTO category_groups (id, name, sort_order, created_at, updated_at)
VALUES (
    '01a13243-efa9-7b54-b1f7-dea052230fce', 'Tzedaka', 35,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

UPDATE categories
SET name = 'Tzedaka',
    group_id = (SELECT id FROM category_groups WHERE name = 'Tzedaka'),
    sort_order = 10,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE name = 'Giving';

INSERT OR IGNORE INTO planning_target_overrides
    (category_id, month, amount_minor, currency, updated_at)
SELECT category_id, month, amount_minor, currency, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tracking_budget_targets;

INSERT OR IGNORE INTO institutions (id, provider, external_id, name, created_at)
VALUES (
    '01a13243-efa9-7b54-b1f7-dea052230fcf', 'manual', 'fintracka-manual',
    'FinTracka manual entries', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT OR IGNORE INTO provider_connections
    (id, provider, external_connection_id, institution_id, status, created_at, updated_at, environment)
VALUES (
    '01a13243-efa9-7b54-b1f7-dea052230fd0', 'manual', 'fintracka-manual',
    '01a13243-efa9-7b54-b1f7-dea052230fcf', 'active',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
);

INSERT OR IGNORE INTO accounts (
    id, connection_id, provider_account_id, name, type, subtype, nature,
    currency, status, include_overview, include_budget, include_net,
    include_export, spending_owner, created_at, updated_at
)
VALUES (
    '01a13243-efa9-7b54-b1f7-dea052230fd1',
    '01a13243-efa9-7b54-b1f7-dea052230fd0',
    'fintracka-manual-cash', 'Manual cash', 'cash', 'cash', 'asset', 'USD',
    'active', 1, 1, 0, 1, 'Shared',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
