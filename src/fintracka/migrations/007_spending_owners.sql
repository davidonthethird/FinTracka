ALTER TABLE accounts ADD COLUMN spending_owner TEXT NOT NULL DEFAULT 'Shared'
    CHECK(spending_owner IN ('David', 'Ariela', 'Shared'));
ALTER TABLE transactions ADD COLUMN spending_owner TEXT
    CHECK(spending_owner IN ('David', 'Ariela', 'Shared') OR spending_owner IS NULL);

-- Accounts connected before household attribution was introduced belong to
-- David. Accounts connected later remain Shared until assigned once in the UI.
UPDATE accounts SET spending_owner = 'David';
