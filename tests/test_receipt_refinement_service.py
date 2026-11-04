from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

from fintracka.mobile_command_client import ClaimedReceiptRefinement
from fintracka.receipt_refinement_service import process_receipt_refinements


@dataclass
class Client:
    jobs: tuple[ClaimedReceiptRefinement, ...]
    completed: list[tuple[str, str, str, str, str]]
    failed: list[tuple[str, str, str]]
    complete_error: bool = False
    fail_error: bool = False

    def active_receipt_refinement_ids(self):
        return frozenset(job.id for job in self.jobs)

    def claim_receipt_refinements(self, limit: int = 3):
        assert limit == 3
        return self.jobs

    def complete_receipt_refinement(self, job_id, claim_token, input_digest, text, model_result):
        if self.complete_error:
            raise OSError("response lost")
        self.completed.append((job_id, claim_token, input_digest, text, model_result))

    def fail_receipt_refinement(self, job_id, claim_token, error_code):
        self.failed.append((job_id, claim_token, error_code))
        if self.fail_error:
            raise OSError("response lost")
        return "pending" if error_code in {"MODEL_UNAVAILABLE", "VISION_FAILED", "PACKAGE_NOT_FOUND"} else "failed"


def test_processes_strict_package_and_deletes_images_after_completion(tmp_path: Path) -> None:
    job = claimed("00000000-0000-4000-8000-000000000001")
    package = queue_package(tmp_path, job.id)
    client = Client((job,), [], [])

    def helper(path: Path) -> dict[str, str]:
        assert path == package
        return {"text": "SHOP TOTAL 1.00", "model_result": "{}"}

    result = process_receipt_refinements(client, tmp_path, helper)
    assert result == {"claimed": 1, "completed": 1, "failed": 0, "deferred": 0}
    assert client.completed == [(job.id, job.claim_token, job.input_digest, "SHOP TOTAL 1.00", "{}")]
    assert not package.exists()


def test_missing_package_retries_safely_without_deleting_other_files(tmp_path: Path) -> None:
    outside = tmp_path / "keep.txt"
    outside.write_text("keep")
    job = claimed("00000000-0000-4000-8000-000000000002")
    client = Client((job,), [], [])
    result = process_receipt_refinements(client, tmp_path, lambda _: {})
    assert result["deferred"] == 1
    assert result["failed"] == 0
    assert client.failed == [(job.id, job.claim_token, "PACKAGE_NOT_FOUND")]
    assert outside.read_text() == "keep"


def test_transient_helper_errors_keep_pending_package_for_retry(tmp_path: Path) -> None:
    job = claimed("00000000-0000-4000-8000-000000000003")
    package = queue_package(tmp_path, job.id)
    client = Client((job,), [], [])

    def helper(_: Path):
        raise RuntimeError("MODEL_UNAVAILABLE")

    result = process_receipt_refinements(client, tmp_path, helper)
    assert result["deferred"] == 1
    assert result["failed"] == 0
    assert client.failed == [(job.id, job.claim_token, "MODEL_UNAVAILABLE")]
    assert package.is_dir()
    assert not (tmp_path / "failed" / job.id).exists()


def test_permanent_invalid_package_moves_to_failed(tmp_path: Path) -> None:
    job = claimed("00000000-0000-4000-8000-000000000013")
    package = queue_package(tmp_path, job.id)
    client = Client((job,), [], [])

    def helper(_: Path):
        raise RuntimeError("UNRECONCILED")

    result = process_receipt_refinements(client, tmp_path, helper)
    assert result["failed"] == 1
    assert not package.exists()
    assert (tmp_path / "failed" / job.id).is_dir()


def test_lost_terminal_failure_response_preserves_package_for_browser_retry(tmp_path: Path) -> None:
    job = claimed("00000000-0000-4000-8000-000000000018")
    package = queue_package(tmp_path, job.id)
    client = Client((job,), [], [], fail_error=True)

    def helper(_: Path):
        raise RuntimeError("UNRECONCILED")

    result = process_receipt_refinements(client, tmp_path, helper)

    assert result["deferred"] == 1
    assert not package.exists()
    assert (tmp_path / "failed" / job.id).is_dir()


def test_rejects_symlinked_receipt_page_without_reading_target(tmp_path: Path) -> None:
    job = claimed("00000000-0000-4000-8000-000000000016")
    package = queue_package(tmp_path, job.id)
    outside = tmp_path / "private.txt"
    outside.write_text("must not be read")
    (package / "page-001.heic").unlink()
    (package / "page-001.heic").symlink_to(outside)
    called = False

    def helper(_: Path):
        nonlocal called
        called = True
        return {}

    result = process_receipt_refinements(Client((job,), [], []), tmp_path, helper)
    assert result["failed"] == 1
    assert not called


def test_lost_completion_response_never_downgrades_or_deletes_package(tmp_path: Path) -> None:
    job = claimed("00000000-0000-4000-8000-000000000014")
    package = queue_package(tmp_path, job.id)
    client = Client((job,), [], [], complete_error=True)

    result = process_receipt_refinements(client, tmp_path,
        lambda _: {"text": "SHOP ITEM 1.00 TOTAL 1.00", "model_result": "{}"})

    assert result["deferred"] == 1
    assert client.failed == []
    assert package.is_dir()


def test_explicit_retry_restores_failed_package_to_pending(tmp_path: Path) -> None:
    job = claimed("00000000-0000-4000-8000-000000000017")
    package = queue_package(tmp_path, job.id)
    failed = tmp_path / "failed" / job.id
    failed.parent.mkdir(parents=True)
    package.replace(failed)
    client = Client((job,), [], [])

    result = process_receipt_refinements(client, tmp_path,
        lambda _: {"text": "SHOP ITEM 1.00 TOTAL 1.00", "model_result": "{}"})

    assert result["completed"] == 1
    assert not failed.exists()
    assert not package.exists()


def test_removes_pending_packages_that_no_longer_have_live_jobs(tmp_path: Path) -> None:
    orphan = queue_package(tmp_path, "00000000-0000-4000-8000-000000000015")
    unrelated = tmp_path / "pending" / "keep-me"
    unrelated.mkdir(parents=True)

    result = process_receipt_refinements(Client((), [], []), tmp_path, lambda _: {})

    assert result == {"claimed": 0, "completed": 0, "failed": 0, "deferred": 0}
    assert not orphan.exists()
    assert unrelated.is_dir()


def test_removes_only_uuid_failed_packages_older_than_seven_days(tmp_path: Path) -> None:
    failed = tmp_path / "failed"
    old = failed / "00000000-0000-4000-8000-000000000010"
    recent = failed / "00000000-0000-4000-8000-000000000011"
    unrelated = failed / "keep-me"
    for path in (old, recent, unrelated):
        path.mkdir(parents=True)
    eight_days_ago = time.time() - 8 * 24 * 60 * 60
    os.utime(old, (eight_days_ago, eight_days_ago))

    result = process_receipt_refinements(Client((), [], []), tmp_path, lambda _: {})

    assert result == {"claimed": 0, "completed": 0, "failed": 0, "deferred": 0}
    assert not old.exists()
    assert recent.is_dir()
    assert unrelated.is_dir()


def queue_package(root: Path, job_id: str) -> Path:
    package = root / "pending" / job_id
    package.mkdir(parents=True)
    (package / "manifest.json").write_text(json.dumps({
        "contract": "receipt_refinement_package/v1", "refinement_id": job_id,
        "page_count": 1, "created_at": "2026-11-04T12:00:00Z",
    }))
    (package / "page-001.heic").write_bytes(b"image")
    return package


def claimed(job_id: str) -> ClaimedReceiptRefinement:
    return ClaimedReceiptRefinement(job_id, "d" * 64, "t" * 43, "2026-11-04T12:05:00Z")
