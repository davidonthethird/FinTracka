from __future__ import annotations

import sqlite3
from collections.abc import Iterator

import pytest


@pytest.fixture
def memory_db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()
