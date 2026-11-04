from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from fintracka.mobile_command_client import ClaimedReceiptRefinement
from fintracka.db import connect, migrate
from fintracka.keychain import KeychainSecrets
from fintracka.mobile_command_client import MobileCommandClient
from fintracka.mobile_command_config import load_mobile_command_settings

JOB_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z", re.I)
SAFE_ERRORS = {"MODEL_UNAVAILABLE", "VISION_FAILED", "INVALID_PACKAGE", "UNRECONCILED",
               "PACKAGE_NOT_FOUND"}


class RefinementClient(Protocol):
    def claim_receipt_refinements(self, limit: int = 3) -> tuple[ClaimedReceiptRefinement, ...]: ...
    def complete_receipt_refinement(self, job_id: str, claim_token: str, input_digest: str,
                                    text: str, model_result: str) -> None: ...
    def fail_receipt_refinement(self, job_id: str, claim_token: str, error_code: str) -> None: ...


def process_receipt_refinements(
    client: RefinementClient,
    queue_directory: Path,
    helper: Callable[[Path], dict[str, str]],
) -> dict[str, int]:
    result = {"claimed": 0, "completed": 0, "failed": 0}
    queue_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    _remove_expired_failed_packages(queue_directory)
    for job in client.claim_receipt_refinements(3):
        result["claimed"] += 1
        package = queue_directory / "pending" / job.id
        try:
            _validate_package(package, job.id)
            output = helper(package)
            if set(output) != {"text", "model_result"} or not all(
                isinstance(output[key], str) and output[key] for key in output
            ):
                raise RuntimeError("UNRECONCILED")
            client.complete_receipt_refinement(job.id, job.claim_token, job.input_digest,
                                               output["text"], output["model_result"])
            shutil.rmtree(package)
            result["completed"] += 1
        except Exception as error:
            code = str(error) if str(error) in SAFE_ERRORS else "INVALID_PACKAGE"
            client.fail_receipt_refinement(job.id, job.claim_token, code)
            if package.is_dir():
                failed = queue_directory / "failed" / job.id
                failed.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if failed.exists():
                    shutil.rmtree(failed)
                package.replace(failed)
            result["failed"] += 1
    return result


def _remove_expired_failed_packages(queue_directory: Path) -> None:
    failed = queue_directory / "failed"
    if not failed.is_dir():
        return
    cutoff = time.time() - 7 * 24 * 60 * 60
    for package in failed.iterdir():
        try:
            if (package.is_dir() and not package.is_symlink() and JOB_ID.fullmatch(package.name)
                    and package.stat().st_mtime < cutoff):
                shutil.rmtree(package)
        except OSError:
            continue


def process_configured_receipt_refinements(
    database_path: Path, data_directory: Path, secrets: KeychainSecrets,
) -> dict[str, int | bool]:
    binary = data_directory / "tools" / "fintracka-receipt-refiner"
    if not binary.is_file():
        return {"claimed": 0, "completed": 0, "failed": 0, "skipped": True}
    connection = connect(database_path)
    try:
        migrate(connection)
        settings = load_mobile_command_settings(connection)
    finally:
        connection.close()
    if not settings.enabled:
        return {"claimed": 0, "completed": 0, "failed": 0, "skipped": True}
    queue = Path.home() / "Library" / "Mobile Documents" / "com~apple~CloudDocs" / "FinTracka Receipt Queue"
    result = process_receipt_refinements(
        MobileCommandClient.from_settings(settings, secrets), queue,
        lambda package: _run_helper(binary, package),
    )
    return {**result, "skipped": False}


def _run_helper(binary: Path, package: Path) -> dict[str, str]:
    completed = subprocess.run(
        [str(binary), str(package)], check=False, capture_output=True, text=True, timeout=45,
    )
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


def _validate_package(package: Path, job_id: str) -> None:
    if not JOB_ID.fullmatch(job_id) or not package.is_dir():
        raise RuntimeError("PACKAGE_NOT_FOUND")
    try:
        manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
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
