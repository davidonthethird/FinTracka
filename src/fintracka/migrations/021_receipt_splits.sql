ALTER TABLE transactions
ADD COLUMN split_revision INTEGER NOT NULL DEFAULT 0 CHECK(split_revision >= 0);

ALTER TABLE transaction_splits
ADD COLUMN subcategory_id TEXT REFERENCES subcategories(id);
ALTER TABLE transaction_splits
ADD COLUMN spending_owner TEXT CHECK(spending_owner IN ('David', 'Ariela', 'Shared') OR spending_owner IS NULL);
ALTER TABLE transaction_splits
ADD COLUMN receipt_line_id TEXT;
ALTER TABLE transaction_splits
ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'receipt'));

CREATE TABLE receipts (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    cloud_draft_id TEXT NOT NULL UNIQUE CHECK(length(cloud_draft_id) BETWEEN 1 AND 128),
    cloud_revision INTEGER NOT NULL CHECK(cloud_revision >= 1),
    allocation_digest TEXT NOT NULL CHECK(length(allocation_digest) = 64),
    transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),
    merchant TEXT NOT NULL CHECK(length(merchant) <= 160),
    purchase_date TEXT,
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    total_minor INTEGER NOT NULL CHECK(total_minor >= 0),
    body_json TEXT NOT NULL CHECK(json_valid(body_json) AND length(body_json) <= 262144),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE receipt_lines (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    cloud_line_id TEXT NOT NULL CHECK(length(cloud_line_id) BETWEEN 1 AND 128),
    line_order INTEGER NOT NULL CHECK(line_order >= 0),
    description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 200),
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    spending_owner TEXT NOT NULL CHECK(spending_owner IN ('David', 'Ariela', 'Shared')),
    category_id TEXT REFERENCES categories(id),
    subcategory_id TEXT REFERENCES subcategories(id),
    created_at TEXT NOT NULL,
    UNIQUE(receipt_id, cloud_line_id),
    UNIQUE(receipt_id, line_order)
);

CREATE TABLE receipt_applications (
    command_id TEXT PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 128),
    receipt_id TEXT NOT NULL REFERENCES receipts(id),
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    receipt_revision INTEGER NOT NULL CHECK(receipt_revision >= 1),
    allocation_digest TEXT NOT NULL CHECK(length(allocation_digest) = 64),
    prior_split_revision INTEGER NOT NULL CHECK(prior_split_revision >= 0),
    applied_split_revision INTEGER NOT NULL CHECK(applied_split_revision >= 1),
    prior_splits_json TEXT NOT NULL CHECK(json_valid(prior_splits_json)),
    result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json) <= 512),
    actor_member_id TEXT NOT NULL CHECK(length(actor_member_id) BETWEEN 1 AND 128),
    applied_at TEXT NOT NULL
);

CREATE INDEX receipt_lines_receipt_idx ON receipt_lines(receipt_id, line_order);
CREATE INDEX receipt_applications_transaction_idx ON receipt_applications(transaction_id, applied_at);
