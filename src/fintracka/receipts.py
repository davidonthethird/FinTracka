from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any

from fintracka.ids import new_id


class ReceiptError(ValueError):
    pass


class ReceiptConflict(ReceiptError):
    pass


@dataclass(frozen=True)
class ReceiptApplicationResult:
    receipt_id: str
    split_revision: int
    split_count: int


_DRAFT_KEYS = {
    "contract", "status", "merchant", "purchase_date", "currency", "masked_payment_hint",
    "page_count", "subtotal_minor", "discount_minor", "tax_minor", "tip_minor", "fees_minor",
    "total_minor", "lines",
}
_LINE_KEYS = {
    "id", "order", "source_page", "description", "quantity", "unit_amount_minor",
    "item_total_minor", "line_discount_minor", "tax_minor", "tip_minor", "fees_minor",
    "taxable", "owner", "category_id", "subcategory_id", "confidence_basis_points",
    "review_flags",
}
_QUANTITY = re.compile(r"\d{1,6}(?:\.\d{1,3})?\Z")


def canonical_receipt_body(draft: object) -> str:
    _validate_draft_shape(draft)
    return json.dumps(draft, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def receipt_digest(draft: object) -> str:
    return hashlib.sha256(canonical_receipt_body(draft).encode()).hexdigest()


def apply_receipt_split(
    connection: sqlite3.Connection,
    transaction_id: str,
    observed_split_revision: int,
    cloud_draft_id: str,
    receipt_revision: int,
    allocation_digest: str,
    draft: object,
    *,
    command_id: str,
    actor_member_id: str,
) -> ReceiptApplicationResult:
    body = canonical_receipt_body(draft)
    if receipt_digest(draft) != allocation_digest:
        raise ReceiptError("receipt digest does not match")
    parsed = _validate_draft_shape(draft)
    existing_application = connection.execute(
        "SELECT * FROM receipt_applications WHERE command_id = ?", (command_id,)
    ).fetchone()
    if existing_application is not None:
        if (
            existing_application["transaction_id"] != transaction_id
            or existing_application["receipt_revision"] != receipt_revision
            or existing_application["allocation_digest"] != allocation_digest
        ):
            raise ReceiptError("receipt command replay does not match")
        result = json.loads(existing_application["result_json"])
        return ReceiptApplicationResult(**result)

    owns_transaction = not connection.in_transaction
    if owns_transaction:
        connection.execute("BEGIN IMMEDIATE")
    try:
        transaction = connection.execute(
            "SELECT * FROM transactions WHERE id = ?", (transaction_id,)
        ).fetchone()
        if transaction is None:
            raise ReceiptError("transaction not found")
        if transaction["split_revision"] != observed_split_revision:
            raise ReceiptConflict("transaction split revision changed")
        if transaction["pending"] or transaction["tombstoned"] or transaction["user_archived"]:
            raise ReceiptConflict("transaction is not eligible for receipt matching")
        if transaction["amount_minor"] >= 0:
            raise ReceiptError("receipt target must be spending")
        if transaction["currency"] != parsed["currency"]:
            raise ReceiptError("receipt currency does not match transaction")
        if abs(transaction["amount_minor"]) != parsed["total_minor"]:
            raise ReceiptError("receipt amount does not match transaction")
        try:
            distance = abs((date.fromisoformat(transaction["local_date"])
                            - date.fromisoformat(parsed["purchase_date"])).days)
        except (TypeError, ValueError) as error:
            raise ReceiptError("receipt date does not match transaction") from error
        if distance > 7:
            raise ReceiptError("receipt date does not match transaction")
        prior_splits = [dict(row) for row in connection.execute(
            "SELECT * FROM transaction_splits WHERE parent_transaction_id = ? ORDER BY id",
            (transaction_id,),
        )]
        if prior_splits and any(row["source"] != "receipt" for row in prior_splits):
            raise ReceiptConflict("transaction already has manual splits")
        linked = connection.execute(
            "SELECT * FROM receipts WHERE transaction_id = ? OR cloud_draft_id = ?",
            (transaction_id, cloud_draft_id),
        ).fetchall()
        if any(row["transaction_id"] != transaction_id or row["cloud_draft_id"] != cloud_draft_id for row in linked):
            raise ReceiptConflict("receipt or transaction is already matched")

        now = _now()
        receipt_id = linked[0]["id"] if linked else new_id()
        connection.execute("DELETE FROM transaction_splits WHERE parent_transaction_id = ?", (transaction_id,))
        if linked:
            connection.execute("DELETE FROM receipt_lines WHERE receipt_id = ?", (receipt_id,))
            connection.execute(
                """UPDATE receipts SET cloud_revision = ?, allocation_digest = ?, merchant = ?,
                   purchase_date = ?, currency = ?, total_minor = ?, body_json = ?, updated_at = ?
                   WHERE id = ?""",
                (receipt_revision, allocation_digest, parsed["merchant"], parsed["purchase_date"],
                 parsed["currency"], parsed["total_minor"], body, now, receipt_id),
            )
        else:
            connection.execute(
                """INSERT INTO receipts
                   (id, cloud_draft_id, cloud_revision, allocation_digest, transaction_id,
                    merchant, purchase_date, currency, total_minor, body_json, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (receipt_id, cloud_draft_id, receipt_revision, allocation_digest, transaction_id,
                 parsed["merchant"], parsed["purchase_date"], parsed["currency"],
                 parsed["total_minor"], body, now, now),
            )

        sign = -1 if transaction["amount_minor"] < 0 else 1
        split_rows: list[tuple[Any, ...]] = []
        for line in parsed["lines"]:
            final_minor = _line_final(line)
            local_line_id = new_id()
            _validate_taxonomy(connection, line["category_id"], line["subcategory_id"])
            connection.execute(
                """INSERT INTO receipt_lines
                   (id, receipt_id, cloud_line_id, line_order, description, amount_minor,
                    spending_owner, category_id, subcategory_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (local_line_id, receipt_id, line["id"], line["order"], line["description"],
                 final_minor, line["owner"], line["category_id"], line["subcategory_id"], now),
            )
            split_rows.append((new_id(), transaction_id, sign * final_minor,
                               line["category_id"] or transaction["category_id"],
                               line["subcategory_id"], line["owner"], local_line_id, now))
        if sum(row[2] for row in split_rows) != transaction["amount_minor"]:
            raise ReceiptError("receipt splits do not sum to transaction amount")
        connection.executemany(
            """INSERT INTO transaction_splits
               (id, parent_transaction_id, amount_minor, category_id, subcategory_id,
                spending_owner, receipt_line_id, source, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'receipt', ?)""",
            split_rows,
        )
        applied_revision = observed_split_revision + 1
        connection.execute(
            "UPDATE transactions SET has_splits = 1, split_revision = ?, updated_at = ? WHERE id = ?",
            (applied_revision, now, transaction_id),
        )
        result = ReceiptApplicationResult(receipt_id, applied_revision, len(split_rows))
        result_json = json.dumps(result.__dict__, sort_keys=True, separators=(",", ":"))
        connection.execute(
            """INSERT INTO receipt_applications
               (command_id, receipt_id, transaction_id, receipt_revision, allocation_digest,
                prior_split_revision, applied_split_revision, prior_splits_json, result_json,
                actor_member_id, applied_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (command_id, receipt_id, transaction_id, receipt_revision, allocation_digest,
             observed_split_revision, applied_revision,
             json.dumps(prior_splits, sort_keys=True, separators=(",", ":")), result_json,
             actor_member_id, now),
        )
        connection.execute(
            """INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at)
               VALUES (?, ?, 'receipt_split_apply', 'transaction', ?, ?)""",
            (new_id(), f"member:{actor_member_id}", transaction_id, now),
        )
        if owns_transaction:
            connection.commit()
        return result
    except Exception:
        if owns_transaction and connection.in_transaction:
            connection.rollback()
        raise


def _validate_draft_shape(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != _DRAFT_KEYS:
        raise ReceiptError("invalid receipt document")
    draft = value
    if draft["contract"] != "receipt_draft/v1" or draft["status"] not in {
        "editing", "waiting_for_bank", "match_pending", "processing", "matched", "conflict", "dismissed"
    }:
        raise ReceiptError("invalid receipt document")
    if not isinstance(draft["merchant"], str) or len(draft["merchant"]) > 160:
        raise ReceiptError("invalid receipt merchant")
    if draft["purchase_date"] is not None and not isinstance(draft["purchase_date"], str):
        raise ReceiptError("invalid receipt date")
    if not isinstance(draft["currency"], str) or not re.fullmatch(r"[A-Z]{3}", draft["currency"]):
        raise ReceiptError("invalid receipt currency")
    for field in ("page_count", "subtotal_minor", "discount_minor", "tax_minor", "tip_minor", "fees_minor", "total_minor"):
        _minor(draft[field], field)
    if not 0 <= draft["page_count"] <= 12:
        raise ReceiptError("invalid receipt page count")
    lines = draft["lines"]
    if not isinstance(lines, list) or not 1 <= len(lines) <= 250:
        raise ReceiptError("invalid receipt lines")
    identifiers: set[str] = set()
    orders: set[int] = set()
    total = 0
    for line in lines:
        if not isinstance(line, dict) or set(line) != _LINE_KEYS:
            raise ReceiptError("invalid receipt line")
        if not isinstance(line["id"], str) or not 1 <= len(line["id"]) <= 128 or line["id"] in identifiers:
            raise ReceiptError("invalid receipt line id")
        if not isinstance(line["order"], int) or isinstance(line["order"], bool) or line["order"] in orders:
            raise ReceiptError("invalid receipt line order")
        if not isinstance(line["description"], str) or not 1 <= len(line["description"].strip()) <= 200:
            raise ReceiptError("invalid receipt line description")
        if not isinstance(line["quantity"], str) or not _QUANTITY.fullmatch(line["quantity"]):
            raise ReceiptError("invalid receipt quantity")
        for field in ("item_total_minor", "line_discount_minor", "tax_minor", "tip_minor", "fees_minor", "confidence_basis_points"):
            _minor(line[field], field)
        if line["unit_amount_minor"] is not None:
            _minor(line["unit_amount_minor"], "unit_amount_minor")
        if line["owner"] not in {"David", "Ariela", "Shared"}:
            raise ReceiptError("invalid receipt owner")
        if line["line_discount_minor"] > line["item_total_minor"]:
            raise ReceiptError("invalid receipt discount")
        identifiers.add(line["id"]); orders.add(line["order"]); total += _line_final(line)
    if total != draft["total_minor"]:
        raise ReceiptError("receipt line total does not reconcile")
    return draft


def _line_final(line: dict[str, Any]) -> int:
    return (line["item_total_minor"] - line["line_discount_minor"] + line["tax_minor"]
            + line["tip_minor"] + line["fees_minor"])


def _minor(value: object, field: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ReceiptError(f"invalid {field}")


def _validate_taxonomy(connection: sqlite3.Connection, category_id: str | None, subcategory_id: str | None) -> None:
    if category_id is not None and connection.execute(
        "SELECT 1 FROM categories WHERE id = ? AND archived = 0", (category_id,)
    ).fetchone() is None:
        raise ReceiptError("receipt category is unavailable")
    if subcategory_id is not None and connection.execute(
        "SELECT 1 FROM subcategories WHERE id = ? AND category_id = ? AND archived = 0",
        (subcategory_id, category_id),
    ).fetchone() is None:
        raise ReceiptError("receipt subcategory is unavailable")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
