from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from e2e.server import seed_database
from fintracka.db import connect
from fintracka.planning import planning_snapshot
from fintracka.remote_snapshot import (
    MAX_SNAPSHOT_BYTES,
    SnapshotTooLargeError,
    build_remote_snapshot,
    serialize_remote_snapshot,
    snapshot_digest,
    view_key,
)
from fintracka.remote_models import RemoteSnapshotV2
from fintracka.reports import overview


NOW = datetime(2026, 10, 27, 12, 0, tzinfo=timezone.utc)


@pytest.fixture()
def database(tmp_path: Path):
    path = tmp_path / "snapshot.sqlite3"
    seed_database(path)
    connection = connect(path)
    yield connection
    connection.close()


def _snapshot(database):
    return build_remote_snapshot(
        database,
        source_sequence=7,
        history_months=6,
        now=NOW,
        snapshot_id="snapshot-test",
    )


def test_snapshot_v2_capability_is_default_off_and_taxonomy_is_active_only(database) -> None:
    archived_category = database.execute(
        "SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1"
    ).fetchone()[0]
    database.execute("UPDATE categories SET archived = 1 WHERE id = ?", (archived_category,))
    archived_subcategory = database.execute(
        "SELECT id FROM subcategories WHERE archived = 0 ORDER BY id LIMIT 1"
    ).fetchone()[0]
    database.execute(
        "UPDATE subcategories SET archived = 1 WHERE id = ?", (archived_subcategory,)
    )

    disabled = _snapshot(database)
    enabled = build_remote_snapshot(
        database,
        source_sequence=8,
        history_months=6,
        now=NOW,
        snapshot_id="snapshot-enabled",
        mobile_commands_enabled=True,
    )

    assert isinstance(disabled, RemoteSnapshotV2)
    assert disabled.schema_version == 2
    assert disabled.capabilities.commands == {}
    assert enabled.capabilities.commands == {"transaction.set_classification": (1, 2)}
    assert all(item.id != archived_category for item in enabled.taxonomy.categories)
    assert all(item.id != archived_subcategory for item in enabled.taxonomy.subcategories)
    assert all(item.classification_revision >= 0 for item in enabled.transactions)
    active_category_ids = {item.id for item in enabled.taxonomy.categories}
    assert all(item.category_id in active_category_ids for item in enabled.taxonomy.subcategories)
    assert len(serialize_remote_snapshot(enabled)) < MAX_SNAPSHOT_BYTES


def test_snapshot_v2_fixture_is_strict_and_requires_integer_revisions() -> None:
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "remote_snapshot_v2.json").read_text()
    )

    assert RemoteSnapshotV2.model_validate(fixture).schema_version == 2
    fixture["transactions"][0]["classification_revision"] = 1.5
    with pytest.raises(ValueError):
        RemoteSnapshotV2.model_validate(fixture)


def test_snapshot_reuses_local_read_models_in_exact_minor_units(database) -> None:
    snapshot = _snapshot(database)
    expected_overview = overview(database, "2026-10")
    expected_planning = planning_snapshot(database, "2026-10", 6, today=NOW.date())

    assert snapshot.overview["2026-10"].net_position_minor == expected_overview.net_position_minor
    planning = snapshot.planning[view_key("2026-10", window=6)]
    assert planning["actual_total_minor"] == expected_planning.actual_total_minor
    assert isinstance(planning["actual_total_minor"], int)


def test_snapshot_contains_six_transaction_months_and_twelve_month_aggregates(database) -> None:
    snapshot = _snapshot(database)

    assert snapshot.history_start == "2026-05-01"
    assert snapshot.history_end == "2026-10-31"
    assert all("2026-05-01" <= item.local_date <= "2026-10-31" for item in snapshot.transactions)
    assert set(snapshot.overview) == {
        "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
        "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
    }


def test_snapshot_uses_new_york_month_at_utc_month_boundary(database) -> None:
    snapshot = build_remote_snapshot(
        database,
        source_sequence=8,
        history_months=1,
        now=datetime(2026, 11, 1, 1, 0, tzinfo=timezone.utc),
        snapshot_id="snapshot-boundary",
    )

    assert snapshot.history_start == "2026-10-01"
    assert snapshot.history_end == "2026-10-31"
    assert view_key("2026-10", window=6) in snapshot.planning


def test_nested_snapshot_models_publish_only_viewer_fields(database) -> None:
    snapshot = _snapshot(database)
    planning = snapshot.planning[view_key("2026-10", window=6)].model_dump()
    savings = snapshot.savings[view_key("2026-10")].model_dump()
    flow = snapshot.reports[view_key("2026-10")].cash_flow_paths

    assert set(planning) == {
        "month", "target_total_minor", "actual_total_minor", "remaining_total_minor",
        "planned_income_total_minor", "surplus_shortfall_minor", "categories",
    }
    assert all("updated_at" not in category for category in planning["categories"])
    assert all(set(account) == {"account_id", "name", "owner", "balance_minor", "pool"}
               for account in savings["accounts"])
    assert all(len(category["trend"]) <= 12 for category in planning["categories"])
    assert flow and flow.entries
    assert all(set(entry.model_dump()) == {
        "id", "transaction_id", "local_date", "merchant", "description", "category",
        "category_id", "subcategory_id", "subcategory", "amount_minor", "currency",
        "spending_owner",
    } for entry in flow.entries)


def test_snapshot_is_deterministic_for_fixed_clock_and_sequence(database) -> None:
    first = _snapshot(database)
    second = _snapshot(database)
    payload = serialize_remote_snapshot(first)

    assert payload == serialize_remote_snapshot(second)
    assert snapshot_digest(payload) == snapshot_digest(payload)
    assert json.loads(payload)["source_sequence"] == 7


def test_snapshot_excludes_secrets_provider_ids_notes_archived_and_raw_payloads(database) -> None:
    canaries = {
        "provider": "FORBIDDEN_PROVIDER_IDENTIFIER",
        "secret": "FORBIDDEN_KEYCHAIN_REFERENCE",
        "notes": "FORBIDDEN_PRIVATE_NOTE",
        "payload": "FORBIDDEN_RAW_PAYLOAD",
        "archived": "FORBIDDEN_ARCHIVED_DESCRIPTION",
    }
    connection_id = database.execute("SELECT id FROM provider_connections LIMIT 1").fetchone()[0]
    database.execute(
        "UPDATE provider_connections SET external_connection_id = ? WHERE id = ?",
        (canaries["provider"], connection_id),
    )
    database.execute(
        "UPDATE connection_secret_refs SET keychain_account = ? WHERE connection_id = ?",
        (canaries["secret"], connection_id),
    )
    transaction_id = database.execute("SELECT id FROM transactions LIMIT 1").fetchone()[0]
    database.execute("UPDATE transactions SET notes = ? WHERE id = ?", (canaries["notes"], transaction_id))
    database.execute(
        "UPDATE transaction_provider_versions SET sanitized_json = ? WHERE transaction_id = ?",
        (json.dumps({"value": canaries["payload"]}), transaction_id),
    )
    archived_id = database.execute(
        "SELECT id FROM transactions WHERE user_archived = 1 LIMIT 1"
    ).fetchone()
    if archived_id:
        database.execute(
            "UPDATE transactions SET provider_description = ? WHERE id = ?",
            (canaries["archived"], archived_id[0]),
        )

    payload = serialize_remote_snapshot(_snapshot(database)).decode()

    for canary in canaries.values():
        assert canary not in payload


def test_snapshot_rejects_more_than_five_mebibytes(database) -> None:
    snapshot = _snapshot(database)
    oversized = snapshot.model_copy(update={"snapshot_id": "x" * MAX_SNAPSHOT_BYTES})

    with pytest.raises(SnapshotTooLargeError):
        serialize_remote_snapshot(oversized)


def test_snapshot_read_transaction_does_not_mutate_financial_tables(database) -> None:
    tables = ("transactions", "accounts", "planning_target_versions", "savings_ledger_entries")
    before = {table: database.execute(f"SELECT COUNT(*), COALESCE(SUM(rowid), 0) FROM {table}").fetchone()[:] for table in tables}

    _snapshot(database)

    after = {table: database.execute(f"SELECT COUNT(*), COALESCE(SUM(rowid), 0) FROM {table}").fetchone()[:] for table in tables}
    assert after == before
