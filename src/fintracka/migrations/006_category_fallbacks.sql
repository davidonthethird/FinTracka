INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fcb', id, 'Giving', 'expense', 'ordinary', 50, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Lifestyle';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fcc', id, 'Debt payments', 'expense', 'ordinary', 60, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Financial';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fcd', id, 'Other', 'expense', 'ordinary', 70, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Financial';

UPDATE transactions
SET category_id = (SELECT id FROM categories WHERE name = 'Giving'), category_source = 'provider', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE category_id IS NULL AND provider_category_primary = 'GOVERNMENT_AND_NON_PROFIT';
UPDATE transactions
SET category_id = (SELECT id FROM categories WHERE name = 'Debt payments'), category_source = 'provider', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE category_id IS NULL AND provider_category_primary = 'LOAN_PAYMENTS';
UPDATE transactions
SET category_id = (SELECT id FROM categories WHERE name = 'Other'), category_source = 'provider', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE category_id IS NULL AND provider_category_primary = 'OTHER';
