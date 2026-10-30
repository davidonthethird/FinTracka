from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from fintracka.ids import new_id


class ClassificationError(ValueError):
    """A one-time classification cannot be applied."""


class ClassificationConflict(ClassificationError):
    """The transaction classification changed after the caller observed it."""

    def __init__(
        self,
        *,
        current_revision: int,
        category_id: str | None,
        subcategory_id: str | None,
    ) -> None:
        super().__init__("transaction classification changed; refresh and retry")
        self.current_revision = current_revision
        self.category_id = category_id
        self.subcategory_id = subcategory_id


@dataclass(frozen=True)
class ClassificationChange:
    transaction_id: str
    category_id: str | None
    subcategory_id: str | None
    classification_revision: int


def set_transaction_classification_once(
    connection: sqlite3.Connection,
    transaction_id: str,
    category_id: str | None,
    subcategory_id: str | None,
    observed_revision: int,
    *,
    actor: str,
    command_id: str,
) -> ClassificationChange:
    if not isinstance(observed_revision, int) or isinstance(observed_revision, bool) or observed_revision < 0:
        raise ClassificationError("observed revision must be a non-negative integer")
    if not actor or not command_id:
        raise ClassificationError("actor and command ID are required")

    transaction = connection.execute(
        """
        SELECT id, category_id, subcategory_id, classification_revision,
               tombstoned, user_archived
        FROM transactions
        WHERE id = ?
        """,
        (transaction_id,),
    ).fetchone()
    if transaction is None:
        raise ClassificationError("transaction not found")
    if transaction["tombstoned"] or transaction["user_archived"]:
        raise ClassificationError("transaction is not active")
    if transaction["classification_revision"] != observed_revision:
        raise ClassificationConflict(
            current_revision=transaction["classification_revision"],
            category_id=transaction["category_id"],
            subcategory_id=transaction["subcategory_id"],
        )

    _validate_taxonomy(connection, category_id, subcategory_id)
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    cursor = connection.execute(
        """
        UPDATE transactions
        SET category_id = ?,
            category_source = 'manual',
            subcategory_id = ?,
            subcategory_source = 'manual',
            updated_at = ?
        WHERE id = ? AND classification_revision = ?
        """,
        (
            category_id,
            subcategory_id,
            now,
            transaction_id,
            observed_revision,
        ),
    )
    if cursor.rowcount != 1:
        current = connection.execute(
            "SELECT category_id, subcategory_id, classification_revision FROM transactions WHERE id = ?",
            (transaction_id,),
        ).fetchone()
        if current is None:
            raise ClassificationError("transaction not found")
        raise ClassificationConflict(
            current_revision=current["classification_revision"],
            category_id=current["category_id"],
            subcategory_id=current["subcategory_id"],
        )

    updated = connection.execute(
        "SELECT category_id, subcategory_id, classification_revision FROM transactions WHERE id = ?",
        (transaction_id,),
    ).fetchone()
    before = {
        "category_id": transaction["category_id"],
        "subcategory_id": transaction["subcategory_id"],
        "classification_revision": transaction["classification_revision"],
        "command_id": command_id,
    }
    after = {
        "category_id": updated["category_id"],
        "subcategory_id": updated["subcategory_id"],
        "classification_revision": updated["classification_revision"],
        "command_id": command_id,
    }
    connection.execute(
        """
        INSERT INTO audit_events
            (id, actor, action, entity_type, entity_id, occurred_at, before_json, after_json)
        VALUES (?, ?, 'transaction_classification_set', 'transaction', ?, ?, ?, ?)
        """,
        (
            new_id(),
            actor,
            transaction_id,
            now,
            json.dumps(before, sort_keys=True),
            json.dumps(after, sort_keys=True),
        ),
    )
    return ClassificationChange(
        transaction_id=transaction_id,
        category_id=updated["category_id"],
        subcategory_id=updated["subcategory_id"],
        classification_revision=updated["classification_revision"],
    )


def _validate_taxonomy(
    connection: sqlite3.Connection,
    category_id: str | None,
    subcategory_id: str | None,
) -> None:
    if category_id is None:
        if subcategory_id is not None:
            raise ClassificationError("subcategory requires a category")
        return
    category = connection.execute(
        "SELECT 1 FROM categories WHERE id = ? AND archived = 0",
        (category_id,),
    ).fetchone()
    if category is None:
        raise ClassificationError("category is not active")
    if subcategory_id is None:
        return
    subcategory = connection.execute(
        """
        SELECT 1 FROM subcategories
        WHERE id = ? AND category_id = ? AND archived = 0
        """,
        (subcategory_id, category_id),
    ).fetchone()
    if subcategory is None:
        raise ClassificationError("subcategory does not belong to active category")
