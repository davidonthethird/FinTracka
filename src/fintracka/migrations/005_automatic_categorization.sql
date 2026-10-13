ALTER TABLE transactions ADD COLUMN provider_category_primary TEXT;
ALTER TABLE transactions ADD COLUMN provider_category_detailed TEXT;
ALTER TABLE transactions ADD COLUMN provider_category_confidence TEXT
    CHECK(provider_category_confidence IN ('VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN') OR provider_category_confidence IS NULL);

CREATE TABLE categorization_undo_batches (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    rule_id TEXT REFERENCES categorization_rules(id),
    prior_rule_category_id TEXT REFERENCES categories(id),
    rule_created INTEGER NOT NULL DEFAULT 0 CHECK(rule_created IN (0, 1)),
    used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE TABLE categorization_undo_items (
    batch_id TEXT NOT NULL REFERENCES categorization_undo_batches(id) ON DELETE CASCADE,
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    category_id TEXT REFERENCES categories(id),
    category_source TEXT CHECK(category_source IN ('manual', 'rule', 'provider') OR category_source IS NULL),
    PRIMARY KEY(batch_id, transaction_id)
);

-- Replaying from the beginning is safe because provider IDs are idempotent. It
-- lets existing Plaid rows receive the newly preserved category facts.
UPDATE provider_checkpoints
SET cursor = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE connection_id IN (SELECT id FROM provider_connections WHERE provider = 'plaid');
