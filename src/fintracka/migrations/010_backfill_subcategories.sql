CREATE TEMP TABLE _subcategory_backfill (
    transaction_id TEXT PRIMARY KEY,
    subcategory_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('rule', 'provider'))
);

WITH ranked_matches AS (
    SELECT t.id transaction_id, r.subcategory_id,
           CASE r.origin WHEN 'user' THEN 'rule' ELSE 'provider' END source,
           ROW_NUMBER() OVER (
               PARTITION BY t.id
               ORDER BY
                   CASE
                       WHEN r.origin = 'user' AND r.match_type = 'merchant' THEN 0
                       WHEN r.origin = 'built_in' AND r.match_type = 'merchant' THEN 1
                       ELSE 2
                   END,
                   r.priority,
                   r.id
           ) match_rank
    FROM transactions t
    JOIN transaction_subcategory_rules r
      ON r.enabled = 1 AND r.category_id = t.category_id
     AND (
         (r.match_type = 'merchant'
          AND r.match_text = upper(trim(COALESCE(t.provider_merchant, ''))) COLLATE NOCASE)
         OR
         (r.match_type = 'plaid_detailed'
          AND r.match_text = upper(trim(COALESCE(t.provider_category_detailed, ''))) COLLATE NOCASE)
     )
    WHERE t.subcategory_id IS NULL
)
INSERT INTO _subcategory_backfill (transaction_id, subcategory_id, source)
SELECT transaction_id, subcategory_id, source
FROM ranked_matches
WHERE match_rank = 1;

INSERT INTO _subcategory_backfill (transaction_id, subcategory_id, source)
SELECT t.id, s.id, 'provider'
FROM transactions t
JOIN subcategories s ON s.id = (
    SELECT candidate.id
    FROM subcategories candidate
    WHERE candidate.category_id = t.category_id
      AND candidate.archived = 0
      AND candidate.name IN ('General', 'Other')
    ORDER BY CASE candidate.name WHEN 'General' THEN 0 ELSE 1 END,
             candidate.sort_order,
             candidate.id
    LIMIT 1
)
WHERE t.subcategory_id IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM _subcategory_backfill b WHERE b.transaction_id = t.id
  );

INSERT INTO audit_events
    (id, actor, action, entity_type, entity_id, occurred_at, before_json, after_json)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) ||
       '-7' || substr(lower(hex(randomblob(2))), 2) ||
       '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       'migration', 'subcategory_assign', 'transaction', b.transaction_id,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       json_object('subcategory_id', NULL, 'subcategory_source', NULL),
       json_object('subcategory_id', b.subcategory_id, 'subcategory_source', b.source)
FROM _subcategory_backfill b;

UPDATE transactions
SET provider_subcategory_id = CASE
        WHEN category_source = 'provider' THEN (
            SELECT b.subcategory_id
            FROM _subcategory_backfill b
            WHERE b.transaction_id = transactions.id
        )
        ELSE provider_subcategory_id
    END,
    subcategory_id = (
        SELECT b.subcategory_id
        FROM _subcategory_backfill b
        WHERE b.transaction_id = transactions.id
    ),
    subcategory_source = (
        SELECT b.source
        FROM _subcategory_backfill b
        WHERE b.transaction_id = transactions.id
    ),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (SELECT transaction_id FROM _subcategory_backfill);

DROP TABLE _subcategory_backfill;
