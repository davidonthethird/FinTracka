from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from fintracka.ids import new_id


class SubcategoryError(ValueError):
    pass


@dataclass(frozen=True)
class SubcategoryAssignmentResult:
    affected_count: int
    undo_id: str


def list_subcategories(
    connection: sqlite3.Connection, category_id: str | None = None
) -> list[dict[str, object]]:
    parameters: tuple[str, ...] = ()
    where = "WHERE s.archived = 0"
    if category_id is not None:
        where += " AND s.category_id = ?"
        parameters = (category_id,)
    return [
        dict(row)
        for row in connection.execute(
            f"""
            SELECT s.id, s.category_id, s.name, s.sort_order, c.name category_name
            FROM subcategories s JOIN categories c ON c.id = s.category_id
            {where}
            ORDER BY c.sort_order, c.name, s.sort_order, s.name, s.id
            """,
            parameters,
        )
    ]


def create_subcategory(connection: sqlite3.Connection, category_id: str, name: str) -> str:
    clean_name = " ".join(name.split())
    if not clean_name or len(clean_name) > 80:
        raise SubcategoryError("subcategory name must be between 1 and 80 characters")
    category = connection.execute(
        "SELECT 1 FROM categories WHERE id = ? AND category_type = 'expense' AND archived = 0",
        (category_id,),
    ).fetchone()
    if category is None:
        raise SubcategoryError("active expense category not found")
    if connection.execute(
        "SELECT 1 FROM subcategories WHERE category_id = ? AND name = ? COLLATE NOCASE",
        (category_id, clean_name),
    ).fetchone():
        raise SubcategoryError("subcategory already exists")
    identifier = new_id()
    now = _now()
    sort_order = connection.execute(
        "SELECT COALESCE(MAX(sort_order), 0) + 10 FROM subcategories WHERE category_id = ?",
        (category_id,),
    ).fetchone()[0]
    connection.execute(
        """
        INSERT INTO subcategories (id, category_id, name, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (identifier, category_id, clean_name, sort_order, now, now),
    )
    _audit(connection, "user", "subcategory_create", "subcategory", identifier, now)
    return identifier


def automatic_subcategory_id(
    connection: sqlite3.Connection,
    category_id: str | None,
    merchant: str | None,
    provider_detailed: str | None,
) -> str | None:
    return _automatic_subcategory_match(
        connection, category_id, merchant, provider_detailed
    )[0]


def automatic_subcategory_source(
    connection: sqlite3.Connection,
    category_id: str | None,
    merchant: str | None,
    provider_detailed: str | None,
) -> str | None:
    identifier, origin = _automatic_subcategory_match(
        connection, category_id, merchant, provider_detailed
    )
    if identifier is None:
        return None
    return "rule" if origin == "user" else "provider"


def _automatic_subcategory_match(
    connection: sqlite3.Connection,
    category_id: str | None,
    merchant: str | None,
    provider_detailed: str | None,
) -> tuple[str | None, str | None]:
    if category_id is None:
        return None, None
    normalized_merchant = _normalize(merchant)
    normalized_detail = _normalize(provider_detailed)
    candidates = (
        ("user", "merchant", normalized_merchant),
        ("built_in", "merchant", normalized_merchant),
        ("built_in", "plaid_detailed", normalized_detail),
    )
    for origin, match_type, match_text in candidates:
        if not match_text:
            continue
        row = connection.execute(
            """
            SELECT subcategory_id
            FROM transaction_subcategory_rules
            WHERE enabled = 1 AND origin = ? AND match_type = ?
              AND match_text = ? COLLATE NOCASE AND category_id = ?
            ORDER BY priority, id LIMIT 1
            """,
            (origin, match_type, match_text, category_id),
        ).fetchone()
        if row:
            return row[0], origin
    fallback = connection.execute(
        """
        SELECT id FROM subcategories
        WHERE category_id = ? AND archived = 0 AND name IN ('General', 'Other')
        ORDER BY CASE name WHEN 'General' THEN 0 ELSE 1 END, sort_order, id LIMIT 1
        """,
        (category_id,),
    ).fetchone()
    return (fallback[0], "built_in") if fallback else (None, None)


def assign_subcategory(
    connection: sqlite3.Connection,
    transaction_id: str,
    subcategory_id: str,
    scope: str,
) -> SubcategoryAssignmentResult:
    if scope not in {"one_time", "future", "past_and_future"}:
        raise SubcategoryError("invalid subcategory scope")
    transaction = connection.execute(
        "SELECT * FROM transactions WHERE id = ?", (transaction_id,)
    ).fetchone()
    if transaction is None:
        raise SubcategoryError("transaction not found")
    child = connection.execute(
        "SELECT category_id FROM subcategories WHERE id = ? AND archived = 0",
        (subcategory_id,),
    ).fetchone()
    if child is None or child[0] != transaction["category_id"]:
        raise SubcategoryError("subcategory does not belong to transaction category")

    merchant = _normalize(
        transaction["user_merchant"] or transaction["provider_merchant"]
    )
    if transaction["is_cash_withdrawal"] or not merchant:
        scope = "one_time"

    matching = [transaction]
    if scope == "past_and_future":
        matching = list(
            connection.execute(
                """
                SELECT * FROM transactions
                WHERE (tombstoned = 0 AND category_id = ? AND is_cash_withdrawal = 0
                  AND id = ?) OR (
                    tombstoned = 0 AND category_id = ? AND is_cash_withdrawal = 0
                    AND subcategory_source IS NOT 'manual'
                    AND upper(trim(COALESCE(NULLIF(user_merchant, ''), provider_merchant, ''))) = ?
                  )
                """,
                (transaction["category_id"], transaction_id, transaction["category_id"], merchant),
            )
        )

    now = _now()
    rule_id: str | None = None
    prior_rule_subcategory_id: str | None = None
    rule_created = 0
    if scope != "one_time":
        existing = connection.execute(
            """
            SELECT id, subcategory_id FROM transaction_subcategory_rules
            WHERE origin = 'user' AND match_type = 'merchant'
              AND match_text = ? COLLATE NOCASE AND category_id = ?
            """,
            (merchant, transaction["category_id"]),
        ).fetchone()
        if existing:
            rule_id = existing["id"]
            prior_rule_subcategory_id = existing["subcategory_id"]
            connection.execute(
                """
                UPDATE transaction_subcategory_rules
                SET subcategory_id = ?, enabled = 1, updated_at = ? WHERE id = ?
                """,
                (subcategory_id, now, rule_id),
            )
            _audit(connection, "user", "subcategory_rule_update", "subcategory_rule", rule_id, now)
        else:
            rule_id = new_id()
            rule_created = 1
            connection.execute(
                """
                INSERT INTO transaction_subcategory_rules
                    (id, match_type, match_text, category_id, subcategory_id, priority,
                     enabled, origin, created_at, updated_at)
                VALUES (?, 'merchant', ?, ?, ?, 0, 1, 'user', ?, ?)
                """,
                (rule_id, merchant, transaction["category_id"], subcategory_id, now, now),
            )
            _audit(connection, "user", "subcategory_rule_create", "subcategory_rule", rule_id, now)

    undo_id = new_id()
    connection.execute(
        """
        INSERT INTO subcategory_undo_batches
            (id, rule_id, prior_rule_subcategory_id, rule_created, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (undo_id, rule_id, prior_rule_subcategory_id, rule_created, now),
    )
    connection.executemany(
        """
        INSERT INTO subcategory_undo_items
            (batch_id, transaction_id, subcategory_id, subcategory_source)
        VALUES (?, ?, ?, ?)
        """,
        [
            (undo_id, row["id"], row["subcategory_id"], row["subcategory_source"])
            for row in matching
        ],
    )
    for row in matching:
        source = "manual" if row["id"] == transaction_id else "rule"
        connection.execute(
            """
            UPDATE transactions SET subcategory_id = ?, subcategory_source = ?, updated_at = ?
            WHERE id = ?
            """,
            (subcategory_id, source, now, row["id"]),
        )
        _audit(
            connection,
            "user" if source == "manual" else "rule",
            "subcategory_assign",
            "transaction",
            row["id"],
            now,
        )
    return SubcategoryAssignmentResult(len(matching), undo_id)


def reprocess_subcategory_rule(connection: sqlite3.Connection, rule_id: str) -> int:
    rule = connection.execute(
        "SELECT * FROM transaction_subcategory_rules WHERE id = ? AND enabled = 1",
        (rule_id,),
    ).fetchone()
    if rule is None:
        raise SubcategoryError("subcategory rule not found")
    if rule["match_type"] != "merchant":
        return 0
    now = _now()
    changed = 0
    rows = connection.execute(
        """
        SELECT * FROM transactions
        WHERE tombstoned = 0 AND category_id = ? AND is_cash_withdrawal = 0
          AND subcategory_source IS NOT 'manual'
          AND upper(trim(COALESCE(NULLIF(user_merchant, ''), provider_merchant, ''))) = ?
        """,
        (rule["category_id"], _normalize(rule["match_text"])),
    ).fetchall()
    for row in rows:
        if row["subcategory_id"] == rule["subcategory_id"] and row["subcategory_source"] == "rule":
            continue
        connection.execute(
            """
            UPDATE transactions SET subcategory_id = ?, subcategory_source = 'rule', updated_at = ?
            WHERE id = ?
            """,
            (rule["subcategory_id"], now, row["id"]),
        )
        _audit(connection, "rule", "subcategory_assign", "transaction", row["id"], now)
        changed += 1
    return changed


def _normalize(value: str | None) -> str:
    return " ".join((value or "").split()).upper()


def _audit(
    connection: sqlite3.Connection,
    actor: str,
    action: str,
    entity_type: str,
    entity_id: str,
    now: str,
) -> None:
    connection.execute(
        """
        INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (new_id(), actor, action, entity_type, entity_id, now),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
