from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Mapping, Protocol

from fintracka.mobile_command_client import ClaimedReceiptRefinement
from fintracka.db import connect, migrate
from fintracka.keychain import KeychainSecrets
from fintracka.mobile_command_client import MobileCommandClient, MobileCommandClientError
from fintracka.mobile_command_config import load_mobile_command_settings

JOB_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z", re.I)
SAFE_ERRORS = {"MODEL_UNAVAILABLE", "VISION_FAILED", "INVALID_PACKAGE", "UNRECONCILED",
               "PACKAGE_NOT_FOUND"}
RETRYABLE_ERRORS = {"MODEL_UNAVAILABLE", "VISION_FAILED", "PACKAGE_NOT_FOUND"}
MAX_PAGE_BYTES = 20 * 1024 * 1024
MAX_PACKAGE_BYTES = 100 * 1024 * 1024
MAX_TEXT_BYTES = 400 * 1024
SETTLE_SECONDS = 2
QUEUE_MANIFEST_KEYS = {
    "contract", "handoff_id", "page_count", "created_at", "on_device_status",
    "on_device_duration_ms", "private_cloud_compute_status",
    "private_cloud_compute_duration_ms",
}
MODEL_STATUSES = {"completed", "unavailable", "rate_limited", "failed"}


class RefinementClient(Protocol):
    def active_receipt_refinement_ids(self) -> frozenset[str]: ...
    def claim_receipt_refinements(self, limit: int = 3) -> tuple[ClaimedReceiptRefinement, ...]: ...
    def complete_receipt_refinement(self, job_id: str, claim_token: str, input_digest: str,
                                    text: str, model_result: str) -> None: ...
    def fail_receipt_refinement(self, job_id: str, claim_token: str, error_code: str) -> str: ...


class QueueHandoffClient(Protocol):
    def active_receipt_queue_handoff_ids(self) -> frozenset[str]: ...
    def start_receipt_queue_handoff(self, handoff_id: str) -> str: ...
    def fail_receipt_queue_handoff(self, handoff_id: str, error_code: str) -> str: ...
    def complete_receipt_queue_handoff(
        self, handoff_id: str, capture: Mapping[str, object],
    ) -> str: ...


class _PackageNotReady(RuntimeError):
    pass


class _InvalidQueuePackage(RuntimeError):
    pass


def process_receipt_refinements(
    client: RefinementClient,
    queue_directory: Path,
    helper: Callable[[Path], dict[str, str]],
    preserve_ids: frozenset[str] = frozenset(),
) -> dict[str, int]:
    result = {"claimed": 0, "completed": 0, "failed": 0, "deferred": 0}
    queue_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    _remove_expired_failed_packages(queue_directory)
    _remove_orphan_pending_packages(
        queue_directory, client.active_receipt_refinement_ids() | preserve_ids,
    )
    for job in client.claim_receipt_refinements(3):
        result["claimed"] += 1
        package = queue_directory / "pending" / job.id
        _restore_failed_package(queue_directory, job.id, package)
        try:
            _validate_package(package, job.id)
            output = helper(package)
            if set(output) != {"text", "model_result"} or not all(
                isinstance(output[key], str) and output[key] for key in output
            ):
                raise RuntimeError("UNRECONCILED")
        except Exception as error:
            code = str(error) if str(error) in SAFE_ERRORS else "INVALID_PACKAGE"
            try:
                status = client.fail_receipt_refinement(job.id, job.claim_token, code)
            except Exception:
                # A terminal failure may have committed even when its response was lost. Preserve
                # the package in failed so an explicit browser retry can restore it to pending.
                if code not in RETRYABLE_ERRORS:
                    _move_package_to_failed(queue_directory, job.id, package)
                result["deferred"] += 1
                continue
            if status == "completed":
                _remove_package(package)
                result["completed"] += 1
            elif status == "failed":
                _move_package_to_failed(queue_directory, job.id, package)
                result["failed"] += 1
            else:
                result["deferred"] += 1
            continue
        try:
            client.complete_receipt_refinement(job.id, job.claim_token, job.input_digest,
                                               output["text"], output["model_result"])
        except Exception:
            # Completion may have committed even if its response was lost. Keep the package for idempotent retry.
            result["deferred"] += 1
            continue
        _remove_package(package)
        result["completed"] += 1
    return result


def process_receipt_queue_handoffs(
    client: QueueHandoffClient,
    queue_directory: Path,
    ocr_fallback: Callable[[Path], str] | None = None,
    *,
    now: Callable[[], float] = time.time,
    active_ids: frozenset[str] | None = None,
) -> dict[str, int]:
    result = {"found": 0, "completed": 0, "failed": 0, "deferred": 0}
    queue_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    _remove_expired_failed_packages(queue_directory)
    active = active_ids if active_ids is not None else client.active_receipt_queue_handoff_ids()
    pending = queue_directory / "pending"
    if not pending.is_dir() or pending.is_symlink():
        return result
    local = _local_queue_package_ids(queue_directory)
    candidates = sorted(
        (pending / item for item in local),
        key=lambda package: (_package_mtime(package), package.name not in active, package.name),
    )[:3]
    for package in candidates:
        result["found"] += 1
        try:
            status = client.start_receipt_queue_handoff(package.name)
        except MobileCommandClientError as error:
            if error.code in {"MOBILE_NOT_FOUND", "MOBILE_GONE"}:
                _move_package_to_failed(queue_directory, package.name, package)
                result["failed"] += 1
            else:
                _defer_queue_package(package)
                result["deferred"] += 1
            continue
        except Exception:
            _defer_queue_package(package)
            result["deferred"] += 1
            continue
        if status == "completed":
            _remove_package(package)
            result["completed"] += 1
            continue
        if status == "failed":
            _move_package_to_failed(queue_directory, package.name, package)
            result["failed"] += 1
            continue
        try:
            capture = _queue_capture(package, package.name, now() - SETTLE_SECONDS, ocr_fallback)
        except _PackageNotReady:
            _defer_queue_package(package)
            result["deferred"] += 1
            continue
        except _InvalidQueuePackage:
            if _report_queue_failure(client, package.name, "INVALID_PACKAGE"):
                _move_package_to_failed(queue_directory, package.name, package)
                result["failed"] += 1
            else:
                _defer_queue_package(package)
                result["deferred"] += 1
            continue
        except Exception as error:
            code = str(error) if str(error) in SAFE_ERRORS else "UNRECONCILED"
            if code in RETRYABLE_ERRORS:
                _defer_queue_package(package)
                result["deferred"] += 1
            elif _report_queue_failure(client, package.name, code):
                _move_package_to_failed(queue_directory, package.name, package)
                result["failed"] += 1
            else:
                _defer_queue_package(package)
                result["deferred"] += 1
            continue
        try:
            client.complete_receipt_queue_handoff(package.name, capture)
        except Exception:
            # The Worker may have committed. Keep the exact package for an idempotent retry.
            _defer_queue_package(package)
            result["deferred"] += 1
            continue
        _remove_package(package)
        result["completed"] += 1
    return result


def _report_queue_failure(client: QueueHandoffClient, handoff_id: str, error_code: str) -> bool:
    try:
        return client.fail_receipt_queue_handoff(handoff_id, error_code) == "failed"
    except Exception:
        return False


def _local_queue_package_ids(queue_directory: Path) -> frozenset[str]:
    pending = queue_directory / "pending"
    if not pending.is_dir() or pending.is_symlink():
        return frozenset()
    return frozenset(
        item.name for item in pending.iterdir()
        if JOB_ID.fullmatch(item.name) and item.is_dir() and not item.is_symlink()
    )


def _package_mtime(package: Path) -> float:
    try:
        return package.stat().st_mtime
    except OSError:
        return 0


def _defer_queue_package(package: Path) -> None:
    try:
        os.utime(package, None, follow_symlinks=False)
    except OSError:
        pass


def _remove_orphan_pending_packages(queue_directory: Path, active_ids: frozenset[str]) -> None:
    pending = queue_directory / "pending"
    if not pending.is_dir() or pending.is_symlink():
        return
    for package in pending.iterdir():
        if (JOB_ID.fullmatch(package.name) and package.name not in active_ids
                and package.is_dir() and not package.is_symlink()):
            _remove_package(package)


def _restore_failed_package(queue_directory: Path, job_id: str, pending: Path) -> None:
    failed = queue_directory / "failed" / job_id
    if (not pending.exists() and failed.is_dir() and not failed.is_symlink()
            and JOB_ID.fullmatch(job_id)):
        pending.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        failed.replace(pending)


def _move_package_to_failed(queue_directory: Path, job_id: str, package: Path) -> None:
    failed = queue_directory / "failed" / job_id
    failed.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    _remove_package(failed)
    if package.is_dir() and not package.is_symlink() and JOB_ID.fullmatch(job_id):
        package.replace(failed)


def _remove_package(package: Path) -> None:
    try:
        if package.is_dir() and not package.is_symlink():
            shutil.rmtree(package)
    except OSError:
        pass


def _remove_expired_failed_packages(queue_directory: Path) -> None:
    failed = queue_directory / "failed"
    if not failed.is_dir():
        return
    cutoff = time.time() - 7 * 24 * 60 * 60
    for package in failed.iterdir():
        try:
            if (package.is_dir() and not package.is_symlink() and JOB_ID.fullmatch(package.name)
                    and package.stat().st_mtime < cutoff):
                _remove_package(package)
        except OSError:
            continue


def _queue_capture(
    package: Path,
    handoff_id: str,
    stable_before: float,
    ocr_fallback: Callable[[Path], str] | None,
) -> dict[str, object]:
    if (JOB_ID.fullmatch(handoff_id) is None or package.name != handoff_id
            or package.is_symlink() or not package.is_dir()):
        raise _InvalidQueuePackage()
    manifest_path = package / "manifest.txt"
    if not manifest_path.exists():
        raise _PackageNotReady()
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise _InvalidQueuePackage()
    if _mtime(manifest_path) > stable_before:
        raise _PackageNotReady()
    manifest = _queue_manifest(_read_text(manifest_path))
    try:
        page_count = int(manifest["page_count"])
    except ValueError as error:
        raise _InvalidQueuePackage() from error
    if (manifest["contract"] != "receipt_queue_capture/v1"
            or manifest["handoff_id"] != handoff_id or not 1 <= page_count <= 12):
        raise _InvalidQueuePackage()
    try:
        created_at = datetime.fromisoformat(manifest["created_at"].replace("Z", "+00:00"))
    except ValueError as error:
        raise _InvalidQueuePackage() from error
    if created_at.tzinfo is None:
        raise _InvalidQueuePackage()
    expected = {
        "manifest.txt", "ocr.txt", "on-device.txt", "private-cloud-compute.txt",
        *(f"page-{index:03d}.heic" for index in range(1, page_count + 1)),
    }
    try:
        actual = {path.name for path in package.iterdir()}
    except OSError as error:
        raise _PackageNotReady() from error
    if not expected.issubset(actual):
        raise _PackageNotReady()
    if actual != expected:
        raise _InvalidQueuePackage()
    manifest_mtime = _mtime(manifest_path)
    total = 0
    for name in expected:
        path = package / name
        try:
            if (path.is_symlink() or not path.is_file()
                    or path.resolve().parent != package.resolve()):
                raise _InvalidQueuePackage()
            stat = path.stat()
        except OSError as error:
            raise _PackageNotReady() from error
        if stat.st_mtime > stable_before or (name != "manifest.txt" and stat.st_mtime > manifest_mtime):
            raise _PackageNotReady()
        if name.startswith("page-") and (stat.st_size <= 0 or stat.st_size > MAX_PAGE_BYTES):
            raise _InvalidQueuePackage()
        if name.endswith(".txt") and stat.st_size > MAX_TEXT_BYTES:
            raise _InvalidQueuePackage()
        total += stat.st_size
    if total > MAX_PACKAGE_BYTES:
        raise _InvalidQueuePackage()

    ocr = _read_text(package / "ocr.txt")
    if len(ocr) > 100_000:
        raise _InvalidQueuePackage()
    if not ocr:
        if ocr_fallback is None:
            raise _PackageNotReady()
        ocr = ocr_fallback(package)
        if not isinstance(ocr, str) or not ocr or len(ocr) > 100_000:
            raise _InvalidQueuePackage()
    runs = [
        _queue_model_run(manifest, package, "on_device", "on-device.txt"),
        _queue_model_run(
            manifest, package, "private_cloud_compute", "private-cloud-compute.txt",
        ),
    ]
    return {
        "contract": "receipt_shortcut_capture/v3",
        "idempotency_key": _queue_digest(package, expected),
        "shortcut_version": 3,
        "text": ocr,
        "runs": runs,
    }


def _queue_manifest(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.count("=") != 1:
            raise _InvalidQueuePackage()
        key, value = line.split("=", 1)
        if key in values:
            raise _InvalidQueuePackage()
        values[key] = value
    if set(values) != QUEUE_MANIFEST_KEYS:
        raise _InvalidQueuePackage()
    return values


def _queue_model_run(
    manifest: dict[str, str], package: Path, model: str, filename: str,
) -> dict[str, object]:
    status_key = f"{model}_status"
    duration_key = f"{model}_duration_ms"
    status = manifest[status_key]
    if status not in MODEL_STATUSES:
        raise _InvalidQueuePackage()
    duration = manifest[duration_key]
    if not duration.isascii() or not duration.isdigit() or int(duration) > 86_400_000:
        raise _InvalidQueuePackage()
    model_result = _read_text(package / filename)
    if len(model_result) > 100_000 or (status == "completed") != bool(model_result.strip()):
        raise _InvalidQueuePackage()
    return {
        "model": model,
        "status": status,
        "duration_ms": int(duration),
        "model_result": model_result,
    }


def _queue_digest(package: Path, names: set[str]) -> str:
    digest = hashlib.sha256()
    for name in sorted(names):
        digest.update(name.encode())
        digest.update(b"\0")
        with (package / name).open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise _InvalidQueuePackage() from error


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError as error:
        raise _PackageNotReady() from error


def process_configured_receipt_refinements(
    database_path: Path, data_directory: Path, secrets: KeychainSecrets,
) -> dict[str, object]:
    binary = data_directory / "tools" / "fintracka-receipt-refiner"
    connection = connect(database_path)
    try:
        migrate(connection)
        settings = load_mobile_command_settings(connection)
    finally:
        connection.close()
    if not settings.enabled:
        return {"claimed": 0, "completed": 0, "failed": 0, "skipped": True}
    queue = Path.home() / "Library" / "Mobile Documents" / "com~apple~CloudDocs" / "FinTracka Receipt Queue"
    try:
        client = MobileCommandClient.from_settings(settings, secrets)
        queue_ids = client.active_receipt_queue_handoff_ids()
        handoffs = process_receipt_queue_handoffs(
            client, queue,
            ocr_fallback=(lambda package: _run_ocr_helper(binary, package))
            if binary.is_file() else None,
            active_ids=queue_ids,
        )
        result = (process_receipt_refinements(
            client, queue, lambda package: _run_helper(binary, package),
            queue_ids | _local_queue_package_ids(queue),
        ) if binary.is_file() else {
            "claimed": 0, "completed": 0, "failed": 0, "deferred": 0,
        })
    except MobileCommandClientError as error:
        return {"claimed": 0, "completed": 0, "failed": 0, "deferred": 0,
                "skipped": True, "error_code": str(error)}
    return {**result, "skipped": False, "queue_handoffs": handoffs}


def _run_helper(binary: Path, package: Path) -> dict[str, str]:
    try:
        completed = subprocess.run(
            [str(binary), str(package)], check=False, capture_output=True, text=True, timeout=45,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("VISION_FAILED") from error
    if completed.returncode != 0:
        code = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "VISION_FAILED"
        raise RuntimeError(code if code in SAFE_ERRORS else "VISION_FAILED")
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("UNRECONCILED") from error
    if not isinstance(value, dict):
        raise RuntimeError("UNRECONCILED")
    return value


def _run_ocr_helper(
    binary: Path, package: Path, *, environment: dict[str, str] | None = None,
) -> str:
    try:
        completed = subprocess.run(
            [str(binary), "--ocr-only", str(package)], check=False, capture_output=True,
            text=True, timeout=45, env=environment,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("VISION_FAILED") from error
    if completed.returncode != 0:
        code = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "VISION_FAILED"
        raise RuntimeError(code if code in SAFE_ERRORS else "VISION_FAILED")
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("UNRECONCILED") from error
    if (not isinstance(value, dict) or set(value) != {"text"}
            or not isinstance(value["text"], str) or not value["text"]
            or len(value["text"]) > 100_000):
        raise RuntimeError("UNRECONCILED")
    return value["text"]


def _validate_package(package: Path, job_id: str) -> None:
    if (not JOB_ID.fullmatch(job_id) or package.is_symlink() or not package.is_dir()
            or package.name != job_id):
        raise RuntimeError("PACKAGE_NOT_FOUND")
    manifest_path = package / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError("INVALID_PACKAGE")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("INVALID_PACKAGE") from error
    if set(manifest) != {"contract", "refinement_id", "page_count", "created_at"}:
        raise RuntimeError("INVALID_PACKAGE")
    count = manifest["page_count"]
    if (manifest["contract"] != "receipt_refinement_package/v1" or manifest["refinement_id"] != job_id
            or not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 12):
        raise RuntimeError("INVALID_PACKAGE")
    expected = {"manifest.json", *(f"page-{index:03d}.heic" for index in range(1, count + 1))}
    if {path.name for path in package.iterdir()} != expected:
        raise RuntimeError("INVALID_PACKAGE")
    total = manifest_path.stat().st_size
    for name in expected - {"manifest.json"}:
        page = package / name
        if (page.is_symlink() or not page.is_file() or page.resolve().parent != package.resolve()):
            raise RuntimeError("INVALID_PACKAGE")
        size = page.stat().st_size
        if size <= 0 or size > MAX_PAGE_BYTES:
            raise RuntimeError("INVALID_PACKAGE")
        total += size
    if total > MAX_PACKAGE_BYTES:
        raise RuntimeError("INVALID_PACKAGE")
