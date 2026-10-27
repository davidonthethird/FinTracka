CREATE TABLE savings_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    activation_month TEXT NOT NULL
        CHECK(activation_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    initialized_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE savings_goals (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    parent_id TEXT REFERENCES savings_goals(id),
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
    pool TEXT NOT NULL CHECK(pool IN ('regular', 'retirement')),
    owner TEXT NOT NULL CHECK(owner IN ('David', 'Ariela', 'Shared')),
    icon_key TEXT NOT NULL CHECK(icon_key IN (
        'piggy_bank', 'shield', 'palm_tree', 'shopping_bag', 'gamepad',
        'house', 'gift', 'car', 'chart', 'wallet', 'coins'
    )),
    color_key TEXT NOT NULL CHECK(color_key IN (
        'blue', 'green', 'orange', 'pink', 'purple', 'teal', 'navy'
    )),
    linked_category_id TEXT REFERENCES categories(id),
    priority INTEGER NOT NULL CHECK(priority >= 0),
    locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    activation_month TEXT NOT NULL
        CHECK(activation_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(parent_id IS NULL OR parent_id != id)
);
CREATE INDEX savings_goals_pool_priority_idx
ON savings_goals(pool, active, priority, id);
CREATE UNIQUE INDEX savings_goals_active_category_idx
ON savings_goals(linked_category_id)
WHERE active = 1 AND linked_category_id IS NOT NULL;

CREATE TABLE savings_goal_target_versions (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    goal_id TEXT NOT NULL REFERENCES savings_goals(id),
    effective_month TEXT NOT NULL
        CHECK(effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    monthly_target_minor INTEGER NOT NULL CHECK(monthly_target_minor >= 0),
    currency TEXT NOT NULL CHECK(currency = 'USD'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(goal_id, effective_month)
);
CREATE INDEX savings_goal_targets_effective_idx
ON savings_goal_target_versions(goal_id, effective_month DESC);

CREATE TABLE savings_month_reviews (
    month TEXT PRIMARY KEY
        CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    target_spending_minor INTEGER NOT NULL CHECK(target_spending_minor >= 0),
    actual_spending_minor INTEGER NOT NULL CHECK(actual_spending_minor >= 0),
    cash_surplus_minor INTEGER NOT NULL,
    suggested_minor INTEGER NOT NULL CHECK(suggested_minor >= 0),
    matched_minor INTEGER NOT NULL DEFAULT 0 CHECK(matched_minor >= 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'waiting', 'added', 'ignored')),
    matched_transaction_id TEXT REFERENCES transactions(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE savings_ledger_entries (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    movement_id TEXT NOT NULL CHECK(length(movement_id) = 36 AND substr(movement_id, 15, 1) = '7'),
    pool TEXT NOT NULL CHECK(pool IN ('regular', 'retirement')),
    bucket_type TEXT NOT NULL CHECK(bucket_type IN ('goal', 'unallocated', 'pending_transfer')),
    goal_id TEXT REFERENCES savings_goals(id),
    amount_minor INTEGER NOT NULL CHECK(amount_minor != 0),
    currency TEXT NOT NULL CHECK(currency = 'USD'),
    event_type TEXT NOT NULL CHECK(event_type IN (
        'opening', 'deposit', 'allocation', 'spending_draw', 'withdrawal',
        'settlement', 'earnings', 'valuation', 'adjustment', 'review', 'reversal'
    )),
    effective_date TEXT NOT NULL
        CHECK(effective_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    source_key TEXT NOT NULL UNIQUE CHECK(length(source_key) BETWEEN 1 AND 240),
    source_transaction_id TEXT REFERENCES transactions(id),
    source_review_month TEXT REFERENCES savings_month_reviews(month),
    manual_asset_id TEXT REFERENCES manual_assets(id),
    reverses_entry_id TEXT UNIQUE REFERENCES savings_ledger_entries(id),
    actor TEXT NOT NULL CHECK(actor IN ('system', 'user')),
    explanation TEXT,
    created_at TEXT NOT NULL,
    CHECK((bucket_type = 'goal' AND goal_id IS NOT NULL) OR
          (bucket_type != 'goal' AND goal_id IS NULL))
);
CREATE INDEX savings_ledger_month_idx
ON savings_ledger_entries(month, pool, bucket_type, goal_id);
CREATE INDEX savings_ledger_transaction_idx
ON savings_ledger_entries(source_transaction_id);
CREATE INDEX savings_ledger_movement_idx
ON savings_ledger_entries(movement_id);

ALTER TABLE accounts ADD COLUMN savings_pool TEXT
    CHECK(savings_pool IN ('regular', 'retirement') OR savings_pool IS NULL);

ALTER TABLE manual_assets ADD COLUMN savings_pool TEXT
    CHECK(savings_pool IN ('regular', 'retirement') OR savings_pool IS NULL);
ALTER TABLE manual_assets ADD COLUMN savings_goal_id TEXT REFERENCES savings_goals(id);
