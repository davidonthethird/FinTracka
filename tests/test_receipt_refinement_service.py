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

    def claim_receipt_refinements(self, limit: int = 3):
        assert limit == 3
        return self.jobs

    def complete_receipt_refinement(self, job_id, claim_token, input_digest, text, model_result):
        self.completed.append((job_id, claim_token, input_digest, text, model_result))

    def fail_receipt_refinement(self, job_id, claim_token, error_code):
        self.failed.append((job_id, claim_token, error_code))


def test_processes_strict_package_and_deletes_images_after_completion(tmp_path: Path) -> None:
    job = claimed("00000000-0000-4000-8000-000000000001")
    package = queue_package(tmp_path, job.id)
    client = Client((job,), [], [])

    def helper(path: Path) -> dict[str, str]:
        assert path == package
        return {"text": "SHOP TOTAL 1.00", "model_result": "{}"}

    result = process_receipt_refinements(client, tmp_path, helper)
    assert result == {"claimed": 1, "completed": 1, "failed": 0}
    assert client.completed == [(job.id, job.claim_token, job.input_digest, "SHOP TOTAL 1.00", "{}")]
    assert not package.exists()


def test_missing_or_invalid_package_fails_safely_without_deleting_other_files(tmp_path: Path) -> None:
    outside = tmp_path / "keep.txt"
    outside.write_text("keep")
    job = claimed("00000000-0000-4000-8000-000000000002")
    client = Client((job,), [], [])
    result = process_receipt_refinements(client, tmp_path, lambda _: {})
    assert result["failed"] == 1
    assert client.failed == [(job.id, job.claim_token, "PACKAGE_NOT_FOUND")]
    assert outside.read_text() == "keep"


def test_helper_errors_move_package_to_failed_and_never_log_private_text(tmp_path: Path) -> None:
    job = claimed("00000000-0000-4000-8000-000000000003")
    package = queue_package(tmp_path, job.id)
    client = Client((job,), [], [])

    def helper(_: Path):
        raise RuntimeError("MODEL_UNAVAILABLE")

    result = process_receipt_refinements(client, tmp_path, helper)
    assert result["failed"] == 1
    assert client.failed == [(job.id, job.claim_token, "MODEL_UNAVAILABLE")]
    assert not package.exists()
    assert (tmp_path / "failed" / job.id).is_dir()


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

    assert result == {"claimed": 0, "completed": 0, "failed": 0}
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
