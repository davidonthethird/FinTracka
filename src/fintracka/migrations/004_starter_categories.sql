INSERT OR IGNORE INTO category_groups (id, name, sort_order, created_at, updated_at)
VALUES
    ('01a13243-efa9-7b54-b1f7-dea052230fb6', 'Income', 10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('01a13243-efa9-7b54-b1f7-dea052230fb7', 'Essentials', 20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('01a13243-efa9-7b54-b1f7-dea052230fb8', 'Lifestyle', 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('01a13243-efa9-7b54-b1f7-dea052230fb9', 'Financial', 40, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fba', id, 'Salary', 'income', 'income', 10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Income';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fbb', id, 'Other income', 'income', 'income', 20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Income';

INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fbc', id, 'Housing', 'expense', 'ordinary', 10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Essentials';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fbd', id, 'Groceries', 'expense', 'ordinary', 20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Essentials';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fbe', id, 'Transport', 'expense', 'ordinary', 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Essentials';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fbf', id, 'Utilities', 'expense', 'ordinary', 40, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Essentials';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fc0', id, 'Insurance', 'expense', 'ordinary', 50, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Essentials';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fc1', id, 'Healthcare', 'expense', 'ordinary', 60, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Essentials';

INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fc2', id, 'Dining', 'expense', 'ordinary', 10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Lifestyle';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fc3', id, 'Shopping', 'expense', 'ordinary', 20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Lifestyle';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fc4', id, 'Fun', 'expense', 'ordinary', 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Lifestyle';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fc5', id, 'Travel', 'expense', 'ordinary', 40, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Lifestyle';

INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fc6', id, 'Fees & interest', 'expense', 'ordinary', 10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Financial';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fc7', id, 'Taxes', 'expense', 'ordinary', 20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Financial';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fc8', id, 'Refunds & reimbursements', 'expense', 'expense_offset', 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Financial';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fc9', id, 'Transfer', 'transfer', 'excluded', 40, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Financial';
INSERT OR IGNORE INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fca', id, 'Credit card payment', 'transfer', 'excluded', 50, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM category_groups WHERE name = 'Financial';
