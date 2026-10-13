from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from fintracka.db import connect
from fintracka.ids import new_id


def recover_interrupted_jobs(connection: sqlite3.Connection) -> int:
    return connection.execute(
        "UPDATE jobs SET status = 'interrupted', finished_at = ? WHERE status IN ('queued', 'running')",
        (_now(),),
    ).rowcount


class JobRunner:
    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="fintracka-job")

    def submit(self, kind: str, work: Callable[[sqlite3.Connection], None]) -> str:
        job_id = new_id()
        connection = connect(self.database_path)
        connection.execute(
            "INSERT INTO jobs (id, kind, status, created_at) VALUES (?, ?, 'queued', ?)",
            (job_id, kind, _now()),
        )
        connection.close()
        self.executor.submit(self._run, job_id, work)
        return job_id

    def close(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=False)

    def _run(self, job_id: str, work: Callable[[sqlite3.Connection], None]) -> None:
        connection = connect(self.database_path)
        try:
            connection.execute(
                "UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", (_now(), job_id)
            )
            work(connection)
            connection.execute(
                "UPDATE jobs SET status = 'succeeded', finished_at = ? WHERE id = ?", (_now(), job_id)
            )
        except Exception:
            connection.execute(
                "UPDATE jobs SET status = 'failed', finished_at = ?, error_code = 'JOB_FAILED' WHERE id = ?",
                (_now(), job_id),
            )
        finally:
            connection.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
