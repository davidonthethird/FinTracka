from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from fintracka.mobile_command_client import ClaimedReceiptRefinement
from fintracka.receipt_refinement_service import (
    _run_ocr_helper,
    process_receipt_queue_handoffs,
    process_receipt_refinements,
)


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


@dataclass
class QueueClient:
    active: frozenset[str]
    captures: list[tuple[str, dict[str, object]]]
    complete_error: bool = False
    starts: list[str] = field(default_factory=list)
    failures: list[tuple[str, str]] = field(default_factory=list)
    fail_error: bool = False
    terminal: dict[str, str] = field(default_factory=dict)

    def active_receipt_queue_handoff_ids(self):
        return self.active

    def complete_receipt_queue_handoff(self, handoff_id, capture):
        self.captures.append((handoff_id, capture))
        if self.complete_error:
            self.terminal[handoff_id] = "completed"
            raise OSError("response lost")
        self.terminal[handoff_id] = "completed"
        return f"/receipts/import/{handoff_id}"

    def start_receipt_queue_handoff(self, handoff_id):
        self.starts.append(handoff_id)
        return self.terminal.get(handoff_id, "processing")

    def fail_receipt_queue_handoff(self, handoff_id, error_code):
        self.failures.append((handoff_id, error_code))
        if self.terminal.get(handoff_id) == "failed":
            return "failed"
        if self.fail_error:
            self.terminal[handoff_id] = "failed"
            raise OSError("response lost")
        self.terminal[handoff_id] = "failed"
        return "failed"


def test_relays_stable_receipt_queue_package_and_deletes_only_after_completion(tmp_path: Path) -> None:
    handoff_id = "00000000-0000-4000-8000-000000000101"
    package = queue_handoff_package(tmp_path, handoff_id)
    client = QueueClient(frozenset({handoff_id}), [])

    result = process_receipt_queue_handoffs(client, tmp_path)

    assert result == {"found": 1, "completed": 1, "failed": 0, "deferred": 0}
    assert not package.exists()
    assert client.starts == [handoff_id]
    capture = client.captures[0][1]
    assert capture["contract"] == "receipt_shortcut_capture/v3"
    assert capture["shortcut_version"] == 3
    assert capture["text"] == "SHOP\nTOTAL 1.00"
    assert capture["idempotency_key"] == __import__("hashlib").sha256(
        package_bytes(handoff_id)
    ).hexdigest()
    assert [run["model"] for run in capture["runs"]] == [
        "on_device", "private_cloud_compute",
    ]


def test_receipt_queue_defers_incomplete_and_unsettled_icloud_packages(tmp_path: Path) -> None:
    missing_id = "00000000-0000-4000-8000-000000000102"
    recent_id = "00000000-0000-4000-8000-000000000103"
    missing = queue_handoff_package(tmp_path, missing_id)
    (missing / "private-cloud-compute.txt").unlink()
    recent = queue_handoff_package(tmp_path, recent_id)
    now = time.time()
    os.utime(recent / "manifest.txt", (now, now))
    client = QueueClient(frozenset({missing_id, recent_id}), [])

    result = process_receipt_queue_handoffs(client, tmp_path, now=lambda: now)

    assert result == {"found": 2, "completed": 0, "failed": 0, "deferred": 2}
    assert missing.is_dir() and recent.is_dir()
    assert client.captures == []


@pytest.mark.parametrize("damage", ["extra", "bad_utf8", "status_mismatch", "symlink"])
def test_receipt_queue_rejects_complete_invalid_packages(tmp_path: Path, damage: str) -> None:
    handoff_id = "00000000-0000-4000-8000-000000000104"
    package = queue_handoff_package(tmp_path, handoff_id)
    if damage == "extra":
        (package / "extra.txt").write_text("no")
    elif damage == "bad_utf8":
        (package / "ocr.txt").write_bytes(b"\xff")
    elif damage == "status_mismatch":
        (package / "on-device.txt").write_text("")
    else:
        outside = tmp_path / "outside.heic"
        outside.write_bytes(b"private")
        (package / "page-001.heic").unlink()
        (package / "page-001.heic").symlink_to(outside)
    make_stable(package)
    client = QueueClient(frozenset({handoff_id}), [])

    result = process_receipt_queue_handoffs(client, tmp_path)

    assert result["failed"] == 1
    assert client.failures == [(handoff_id, "INVALID_PACKAGE")]
    assert client.captures == []
    assert not package.exists()
    assert (tmp_path / "failed" / handoff_id).is_dir()


def test_receipt_queue_processes_at_most_three_serially_and_retains_lost_completion(tmp_path: Path) -> None:
    ids = [f"00000000-0000-4000-8000-{index:012d}" for index in range(201, 205)]
    for handoff_id in ids:
        queue_handoff_package(tmp_path, handoff_id)
    client = QueueClient(frozenset(ids), [], complete_error=True)

    result = process_receipt_queue_handoffs(client, tmp_path)

    assert result == {"found": 3, "completed": 0, "failed": 0, "deferred": 3}
    assert [item[0] for item in client.captures] == ids[:3]
    assert all((tmp_path / "pending" / handoff_id).is_dir() for handoff_id in ids)

    client.active = frozenset()
    replay = process_receipt_queue_handoffs(client, tmp_path)

    assert replay == {"found": 3, "completed": 3, "failed": 0, "deferred": 0}
    assert [item[0] for item in client.captures] == ids[:3]
    assert all(not (tmp_path / "pending" / handoff_id).exists() for handoff_id in ids[:3])
    assert (tmp_path / "pending" / ids[3]).is_dir()


def test_receipt_queue_uses_ocr_only_fallback_when_phone_text_is_blank(tmp_path: Path) -> None:
    handoff_id = "00000000-0000-4000-8000-000000000105"
    package = queue_handoff_package(tmp_path, handoff_id, ocr="")
    client = QueueClient(frozenset({handoff_id}), [])

    result = process_receipt_queue_handoffs(client, tmp_path,
        ocr_fallback=lambda path: "MAC OCR\nTOTAL 1.00" if path == package else "")

    assert result["completed"] == 1
    assert client.captures[0][1]["text"] == "MAC OCR\nTOTAL 1.00"


def test_receipt_queue_isolates_retryable_ocr_failure_and_processes_later_package(tmp_path: Path) -> None:
    failed_id = "00000000-0000-4000-8000-000000000107"
    good_id = "00000000-0000-4000-8000-000000000108"
    failed_package = queue_handoff_package(tmp_path, failed_id, ocr="")
    queue_handoff_package(tmp_path, good_id)
    client = QueueClient(frozenset({failed_id, good_id}), [])

    def fallback(path):
        if path == failed_package:
            raise RuntimeError("VISION_FAILED")
        return "unused"

    result = process_receipt_queue_handoffs(client, tmp_path, ocr_fallback=fallback)

    assert result == {"found": 2, "completed": 1, "failed": 0, "deferred": 1}
    assert failed_package.is_dir()
    assert [item[0] for item in client.captures] == [good_id]


def test_receipt_queue_keeps_package_when_terminal_failure_response_is_lost(tmp_path: Path) -> None:
    handoff_id = "00000000-0000-4000-8000-000000000109"
    package = queue_handoff_package(tmp_path, handoff_id)
    (package / "extra.txt").write_text("invalid")
    make_stable(package)
    client = QueueClient(frozenset({handoff_id}), [], fail_error=True)

    result = process_receipt_queue_handoffs(client, tmp_path)

    assert result == {"found": 1, "completed": 0, "failed": 0, "deferred": 1}
    assert package.is_dir()
    assert not (tmp_path / "failed" / handoff_id).exists()

    client.active = frozenset()
    replay = process_receipt_queue_handoffs(client, tmp_path)

    assert replay == {"found": 1, "completed": 0, "failed": 1, "deferred": 0}
    assert not package.exists()
    assert (tmp_path / "failed" / handoff_id).is_dir()


def test_receipt_queue_never_invokes_ocr_helper_when_phone_text_exists(tmp_path: Path) -> None:
    handoff_id = "00000000-0000-4000-8000-000000000106"
    queue_handoff_package(tmp_path, handoff_id)
    client = QueueClient(frozenset({handoff_id}), [])

    result = process_receipt_queue_handoffs(client, tmp_path,
        ocr_fallback=lambda _: pytest.fail("OCR helper must not run"))

    assert result["completed"] == 1


def test_ocr_helper_uses_ocr_only_mode_and_parses_text(tmp_path: Path) -> None:
    binary = tmp_path / "helper"
    arguments = tmp_path / "arguments"
    binary.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ARGUMENTS\"\nprintf '%s\\n' '{\"text\":\"MAC OCR\"}'\n"
    )
    binary.chmod(0o700)
    package = tmp_path / "package"
    package.mkdir()

    assert _run_ocr_helper(binary, package, environment={"ARGUMENTS": str(arguments)}) == "MAC OCR"
    assert arguments.read_text().splitlines() == ["--ocr-only", str(package)]


MODEL_RESULT = json.dumps({
    "merchant": {"value": "Shop", "evidence": "SHOP"}, "date": None,
    "subtotal": None, "discounts": [], "tax": None, "tip": None, "fees": [],
    "total": {"value_cents": 100, "evidence": "TOTAL 1.00"},
    "lines": [{"description": "ITEM", "amount_cents": 100,
               "description_evidence": "ITEM 1.00", "amount_evidence": "ITEM 1.00"}],
}, separators=(",", ":"))


def queue_handoff_package(root: Path, handoff_id: str, *, ocr: str = "SHOP\nTOTAL 1.00") -> Path:
    package = root / "pending" / handoff_id
    package.mkdir(parents=True)
    (package / "page-001.heic").write_bytes(b"image")
    (package / "ocr.txt").write_text(ocr)
    (package / "on-device.txt").write_text(MODEL_RESULT)
    (package / "private-cloud-compute.txt").write_text(MODEL_RESULT)
    (package / "manifest.txt").write_text("\n".join([
        "contract=receipt_queue_capture/v1", f"handoff_id={handoff_id}", "page_count=1",
        "created_at=2026-11-11T12:00:00Z", "on_device_status=completed",
        "on_device_duration_ms=1000", "private_cloud_compute_status=completed",
        "private_cloud_compute_duration_ms=2000", "",
    ]))
    make_stable(package)
    return package


def make_stable(package: Path) -> None:
    old = time.time() - 10
    for path in package.iterdir():
        os.utime(path, (old, old))
    os.utime(package, (old, old))


def package_bytes(handoff_id: str) -> bytes:
    values = {
        "manifest.txt": "\n".join([
            "contract=receipt_queue_capture/v1", f"handoff_id={handoff_id}", "page_count=1",
            "created_at=2026-11-11T12:00:00Z", "on_device_status=completed",
            "on_device_duration_ms=1000", "private_cloud_compute_status=completed",
            "private_cloud_compute_duration_ms=2000", "",
        ]).encode(),
        "ocr.txt": b"SHOP\nTOTAL 1.00", "on-device.txt": MODEL_RESULT.encode(),
        "page-001.heic": b"image", "private-cloud-compute.txt": MODEL_RESULT.encode(),
    }
    return b"".join(name.encode() + b"\0" + values[name] + b"\0" for name in sorted(values))


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
