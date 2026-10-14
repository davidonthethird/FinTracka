ALTER TABLE provider_connections ADD COLUMN history_available_from TEXT
    CHECK(history_available_from IS NULL OR history_available_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

ALTER TABLE accounts ADD COLUMN include_savings INTEGER NOT NULL DEFAULT 0
    CHECK(include_savings IN (0, 1));

UPDATE accounts SET include_savings = 1 WHERE subtype = 'savings';

UPDATE provider_connections
SET history_available_from = CASE
    WHEN (
        SELECT MIN(t.local_date)
        FROM accounts a JOIN transactions t ON t.account_id = a.id
        WHERE a.connection_id = provider_connections.id
    ) < date(created_at, '-90 days')
    THEN (
        SELECT MIN(t.local_date)
        FROM accounts a JOIN transactions t ON t.account_id = a.id
        WHERE a.connection_id = provider_connections.id
    )
    ELSE date(created_at, '-90 days')
END
WHERE provider = 'plaid';

CREATE TABLE subcategories (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    category_id TEXT NOT NULL REFERENCES categories(id),
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(category_id, name),
    UNIQUE(category_id, id)
);

WITH seed(parent_name, child_name, sort_order) AS (
    VALUES
    ('Dining', 'Restaurants', 10), ('Dining', 'Takeout & delivery', 20),
    ('Dining', 'Coffee & bakeries', 30), ('Dining', 'Bars', 40), ('Dining', 'General', 90),
    ('Fees & interest', 'Bank fees', 10), ('Fees & interest', 'Card interest', 20),
    ('Fees & interest', 'Late fees', 30), ('Fees & interest', 'Other fees', 90),
    ('Housing', 'Rent or mortgage', 10), ('Housing', 'Home maintenance', 20),
    ('Housing', 'Furniture', 30), ('Housing', 'Household services', 40), ('Housing', 'General', 90),
    ('Tzedaka', 'Synagogue & community', 10), ('Tzedaka', 'Torah & education', 20),
    ('Tzedaka', 'Direct assistance', 30), ('Tzedaka', 'Organizations', 40), ('Tzedaka', 'Other', 90),
    ('Groceries', 'Supermarkets', 10), ('Groceries', 'Warehouse clubs', 20),
    ('Groceries', 'Specialty markets', 30), ('Groceries', 'Convenience stores', 40), ('Groceries', 'General', 90),
    ('Shopping', 'Clothing', 10), ('Shopping', 'Home improvement', 20),
    ('Shopping', 'Household', 30), ('Shopping', 'Electronics', 40), ('Shopping', 'Gifts', 50),
    ('Shopping', 'Online shopping', 60), ('Shopping', 'Personal items', 70), ('Shopping', 'General', 90),
    ('Taxes', 'Income tax', 10), ('Taxes', 'Property tax', 20),
    ('Taxes', 'Estimated tax', 30), ('Taxes', 'Other tax', 90),
    ('Fun', 'Entertainment', 10), ('Fun', 'Hobbies', 20), ('Fun', 'Events', 30),
    ('Fun', 'Games', 40), ('Fun', 'Recreation', 50), ('Fun', 'General', 90),
    ('Transport', 'Fuel', 10), ('Transport', 'Auto repairs', 20), ('Transport', 'Parking', 30),
    ('Transport', 'Tolls', 40), ('Transport', 'Public transit', 50), ('Transport', 'Rideshare', 60),
    ('Transport', 'Registration', 70), ('Transport', 'General', 90),
    ('Travel', 'Flights', 10), ('Travel', 'Hotels', 20), ('Travel', 'Car rental', 30),
    ('Travel', 'Travel dining', 40), ('Travel', 'Activities', 50), ('Travel', 'General', 90),
    ('Utilities', 'Electric', 10), ('Utilities', 'Gas', 20), ('Utilities', 'Water', 30),
    ('Utilities', 'Internet', 40), ('Utilities', 'Mobile phone', 50), ('Utilities', 'Waste', 60),
    ('Utilities', 'General', 90),
    ('Insurance', 'Auto', 10), ('Insurance', 'Home or renters', 20), ('Insurance', 'Health', 30),
    ('Insurance', 'Life', 40), ('Insurance', 'Other', 90),
    ('Debt payments', 'Student loans', 10), ('Debt payments', 'Personal loans', 20),
    ('Debt payments', 'Other debt', 90),
    ('Healthcare', 'Doctor', 10), ('Healthcare', 'Dental', 20), ('Healthcare', 'Pharmacy', 30),
    ('Healthcare', 'Vision', 40), ('Healthcare', 'Therapy', 50),
    ('Healthcare', 'Medical supplies', 60), ('Healthcare', 'General', 90),
    ('Other', 'Education', 10), ('Other', 'Children & family', 20), ('Other', 'Personal care', 30),
    ('Other', 'Pets', 40), ('Other', 'Subscriptions', 50), ('Other', 'Cash withdrawal', 60),
    ('Other', 'General', 90)
), numbered AS (
    SELECT parent_name, child_name, sort_order,
           ROW_NUMBER() OVER (ORDER BY parent_name, sort_order, child_name) sequence
    FROM seed
)
INSERT INTO subcategories (id, category_id, name, sort_order, created_at, updated_at)
SELECT '0199a000-0000-7000-8000-' || printf('%012x', sequence),
       c.id, child_name, numbered.sort_order,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM numbered JOIN categories c ON c.name = numbered.parent_name;

ALTER TABLE transactions ADD COLUMN provider_subcategory_id TEXT REFERENCES subcategories(id);
ALTER TABLE transactions ADD COLUMN subcategory_id TEXT REFERENCES subcategories(id);
ALTER TABLE transactions ADD COLUMN subcategory_source TEXT
    CHECK(subcategory_source IN ('manual', 'rule', 'provider') OR subcategory_source IS NULL);

CREATE TRIGGER transactions_subcategory_parent_insert
BEFORE INSERT ON transactions
WHEN NEW.subcategory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM subcategories s WHERE s.id = NEW.subcategory_id AND s.category_id = NEW.category_id
)
BEGIN
    SELECT RAISE(ABORT, 'subcategory does not belong to category');
END;

CREATE TRIGGER transactions_subcategory_parent_update
BEFORE UPDATE OF category_id, subcategory_id ON transactions
WHEN NEW.subcategory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM subcategories s WHERE s.id = NEW.subcategory_id AND s.category_id = NEW.category_id
)
BEGIN
    SELECT RAISE(ABORT, 'subcategory does not belong to category');
END;

CREATE TABLE transaction_subcategory_rules (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    match_type TEXT NOT NULL CHECK(match_type IN ('merchant', 'plaid_detailed')),
    match_text TEXT NOT NULL CHECK(length(trim(match_text)) BETWEEN 1 AND 160),
    category_id TEXT NOT NULL REFERENCES categories(id),
    subcategory_id TEXT NOT NULL REFERENCES subcategories(id),
    priority INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    origin TEXT NOT NULL CHECK(origin IN ('built_in', 'user')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(category_id, subcategory_id) REFERENCES subcategories(category_id, id),
    UNIQUE(origin, match_type, match_text, category_id)
);
CREATE INDEX transaction_subcategory_rules_match_idx
ON transaction_subcategory_rules(enabled, match_type, match_text, priority, id);

WITH seed(match_type, match_text, parent_name, child_name, priority) AS (
    VALUES
    ('merchant', 'LOWE''S', 'Shopping', 'Home improvement', 100),
    ('merchant', 'LOWES', 'Shopping', 'Home improvement', 100),
    ('merchant', 'THE HOME DEPOT', 'Shopping', 'Home improvement', 100),
    ('merchant', 'HOME DEPOT', 'Shopping', 'Home improvement', 100),
    ('merchant', 'ACE HARDWARE', 'Shopping', 'Home improvement', 100),
    ('merchant', 'MACY''S', 'Shopping', 'Clothing', 100),
    ('merchant', 'MACYS', 'Shopping', 'Clothing', 100),
    ('merchant', 'NORDSTROM', 'Shopping', 'Clothing', 100),
    ('merchant', 'OLD NAVY', 'Shopping', 'Clothing', 100),
    ('merchant', 'GAP', 'Shopping', 'Clothing', 100),
    ('merchant', 'H&M', 'Shopping', 'Clothing', 100),
    ('merchant', 'ZARA', 'Shopping', 'Clothing', 100),
    ('merchant', 'TJ MAXX', 'Shopping', 'Clothing', 100),
    ('merchant', 'MARSHALLS', 'Shopping', 'Clothing', 100),
    ('merchant', 'AMAZON', 'Shopping', 'Online shopping', 100),
    ('merchant', 'AMAZON MARKETPLACE', 'Shopping', 'Online shopping', 100),
    ('merchant', 'WHOLE FOODS MARKET', 'Groceries', 'Supermarkets', 100),
    ('merchant', 'TRADER JOE''S', 'Groceries', 'Supermarkets', 100),
    ('merchant', 'ALDI', 'Groceries', 'Supermarkets', 100),
    ('merchant', 'KROGER', 'Groceries', 'Supermarkets', 100),
    ('merchant', 'SHOPRITE', 'Groceries', 'Supermarkets', 100),
    ('merchant', 'WEGMANS', 'Groceries', 'Supermarkets', 100),
    ('merchant', 'STOP & SHOP', 'Groceries', 'Supermarkets', 100),
    ('merchant', 'COSTCO', 'Groceries', 'Warehouse clubs', 100),
    ('merchant', 'SAM''S CLUB', 'Groceries', 'Warehouse clubs', 100),
    ('merchant', 'CVS', 'Healthcare', 'Pharmacy', 100),
    ('merchant', 'CVS PHARMACY', 'Healthcare', 'Pharmacy', 100),
    ('merchant', 'WALGREENS', 'Healthcare', 'Pharmacy', 100),
    ('merchant', 'DUANE READE', 'Healthcare', 'Pharmacy', 100),
    ('merchant', 'RITE AID', 'Healthcare', 'Pharmacy', 100),
    ('merchant', 'NETFLIX', 'Other', 'Subscriptions', 100),
    ('merchant', 'SPOTIFY', 'Other', 'Subscriptions', 100),
    ('merchant', 'HULU', 'Other', 'Subscriptions', 100),
    ('merchant', 'DISNEY PLUS', 'Other', 'Subscriptions', 100),
    ('merchant', 'YOUTUBE PREMIUM', 'Other', 'Subscriptions', 100),
    ('merchant', 'UBER', 'Transport', 'Rideshare', 100),
    ('merchant', 'LYFT', 'Transport', 'Rideshare', 100),
    ('merchant', 'SHELL', 'Transport', 'Fuel', 100),
    ('merchant', 'EXXON', 'Transport', 'Fuel', 100),
    ('merchant', 'BP', 'Transport', 'Fuel', 100),
    ('merchant', 'CHEVRON', 'Transport', 'Fuel', 100),
    ('merchant', 'MOBIL', 'Transport', 'Fuel', 100),
    ('merchant', 'DELTA AIR LINES', 'Travel', 'Flights', 100),
    ('merchant', 'UNITED AIRLINES', 'Travel', 'Flights', 100),
    ('merchant', 'AMERICAN AIRLINES', 'Travel', 'Flights', 100),
    ('merchant', 'SOUTHWEST AIRLINES', 'Travel', 'Flights', 100),
    ('merchant', 'MARRIOTT', 'Travel', 'Hotels', 100),
    ('merchant', 'HILTON', 'Travel', 'Hotels', 100),
    ('merchant', 'HYATT', 'Travel', 'Hotels', 100),
    ('merchant', 'AIRBNB', 'Travel', 'Hotels', 100),
    ('merchant', 'AMC THEATRES', 'Fun', 'Entertainment', 100),
    ('merchant', 'REGAL CINEMAS', 'Fun', 'Entertainment', 100),
    ('merchant', 'STARBUCKS', 'Dining', 'Coffee & bakeries', 100),
    ('merchant', 'DUNKIN', 'Dining', 'Coffee & bakeries', 100),
    ('merchant', 'DOORDASH', 'Dining', 'Takeout & delivery', 100),
    ('merchant', 'UBER EATS', 'Dining', 'Takeout & delivery', 100),
    ('merchant', 'GRUBHUB', 'Dining', 'Takeout & delivery', 100),
    ('plaid_detailed', 'FOOD_AND_DRINK_RESTAURANT', 'Dining', 'Restaurants', 200),
    ('plaid_detailed', 'FOOD_AND_DRINK_COFFEE', 'Dining', 'Coffee & bakeries', 200),
    ('plaid_detailed', 'FOOD_AND_DRINK_FAST_FOOD', 'Dining', 'Takeout & delivery', 200),
    ('plaid_detailed', 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES', 'Shopping', 'Clothing', 200),
    ('plaid_detailed', 'GENERAL_MERCHANDISE_HOME_IMPROVEMENT', 'Shopping', 'Home improvement', 200),
    ('plaid_detailed', 'TRANSPORTATION_GAS', 'Transport', 'Fuel', 200),
    ('plaid_detailed', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES', 'Transport', 'Rideshare', 200),
    ('plaid_detailed', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS', 'Healthcare', 'Pharmacy', 200),
    ('plaid_detailed', 'TRAVEL_FLIGHTS', 'Travel', 'Flights', 200),
    ('plaid_detailed', 'TRAVEL_LODGING', 'Travel', 'Hotels', 200)
), numbered AS (
    SELECT *, ROW_NUMBER() OVER (
        ORDER BY match_type, match_text, parent_name, child_name
    ) sequence
    FROM seed
)
INSERT INTO transaction_subcategory_rules
    (id, match_type, match_text, category_id, subcategory_id, priority, enabled, origin, created_at, updated_at)
SELECT '0199b000-0000-7000-8000-' || printf('%012x', sequence),
       match_type, match_text, c.id, s.id, priority, 1, 'built_in',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM numbered
JOIN categories c ON c.name = numbered.parent_name
JOIN subcategories s ON s.category_id = c.id AND s.name = numbered.child_name;

CREATE TABLE subcategory_undo_batches (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    rule_id TEXT REFERENCES transaction_subcategory_rules(id),
    prior_rule_subcategory_id TEXT REFERENCES subcategories(id),
    rule_created INTEGER NOT NULL DEFAULT 0 CHECK(rule_created IN (0, 1)),
    used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE TABLE subcategory_undo_items (
    batch_id TEXT NOT NULL REFERENCES subcategory_undo_batches(id) ON DELETE CASCADE,
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    subcategory_id TEXT REFERENCES subcategories(id),
    subcategory_source TEXT
        CHECK(subcategory_source IN ('manual', 'rule', 'provider') OR subcategory_source IS NULL),
    PRIMARY KEY(batch_id, transaction_id)
);

CREATE TABLE manual_assets (
    id TEXT PRIMARY KEY CHECK(length(id) = 36 AND substr(id, 15, 1) = '7'),
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
    kind TEXT NOT NULL CHECK(kind IN ('savings', 'investment', 'other')),
    owner TEXT NOT NULL CHECK(owner IN ('David', 'Ariela', 'Shared')),
    current_value_minor INTEGER NOT NULL CHECK(current_value_minor >= 0),
    currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
    as_of_date TEXT NOT NULL CHECK(as_of_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
