INSERT OR IGNORE INTO categories
(id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at)
SELECT '01a13243-efa9-7b54-b1f7-dea052230fd2', id, 'Savings', 'expense',
       'ordinary', 35, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM category_groups WHERE name = 'Financial';

UPDATE transactions
SET category_id = (SELECT id FROM categories WHERE name = 'Savings'),
    category_source = 'rule',
    subcategory_id = NULL,
    subcategory_source = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
    SELECT outgoing.id
    FROM transfer_links link
    JOIN transactions outgoing
      ON outgoing.id IN (link.transaction_a_id, link.transaction_b_id)
     AND outgoing.amount_minor < 0
    JOIN accounts source ON source.id = outgoing.account_id
    JOIN transactions incoming
      ON incoming.id = CASE
          WHEN link.transaction_a_id = outgoing.id THEN link.transaction_b_id
          ELSE link.transaction_a_id END
    JOIN accounts destination ON destination.id = incoming.account_id
    WHERE link.status = 'confirmed'
      AND incoming.amount_minor = -outgoing.amount_minor
      AND source.savings_pool IS NULL
      AND destination.savings_pool IN ('regular', 'retirement')
      AND COALESCE(outgoing.category_source, '') != 'manual'
);
