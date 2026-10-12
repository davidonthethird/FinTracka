from __future__ import annotations

import plistlib
import os
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

LABEL = "com.fintracka.sync"
Runner = Callable[..., subprocess.CompletedProcess[str]]


def build_launch_agent(python: Path, data_directory: Path) -> bytes:
    logs = data_directory / "logs"
    return plistlib.dumps(
        {
            "Label": LABEL,
            "ProgramArguments": [
                str(python),
                "-m",
                "fintracka.cli",
                "sync",
                "--data-dir",
                str(data_directory),
            ],
            "RunAtLoad": True,
            "StartCalendarInterval": {"Hour": 6, "Minute": 17},
            "StandardOutPath": str(logs / "sync.log"),
            "StandardErrorPath": str(logs / "sync-error.log"),
            "ProcessType": "Background",
        },
        sort_keys=True,
    )


def install_launch_agent(destination: Path, python: Path, data_directory: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".fintracka-launchd-", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(build_launch_agent(python, data_directory))
        temporary.chmod(0o600)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return destination


def install_schedule(
    destination: Path,
    python: Path,
    data_directory: Path,
    *,
    runner: Runner = subprocess.run,
    user_id: int | None = None,
) -> Path:
    domain = f"gui/{os.getuid() if user_id is None else user_id}"
    if destination.exists():
        runner(
            ["launchctl", "bootout", domain, str(destination)],
            check=False,
            capture_output=True,
            text=True,
        )
    install_launch_agent(destination, python, data_directory)
    (data_directory / "logs").mkdir(parents=True, exist_ok=True, mode=0o700)
    runner(
        ["launchctl", "bootstrap", domain, str(destination)],
        check=True,
        capture_output=True,
        text=True,
    )
    return destination


def schedule_status(
    destination: Path,
    *,
    runner: Runner = subprocess.run,
    user_id: int | None = None,
) -> dict[str, bool]:
    domain = f"gui/{os.getuid() if user_id is None else user_id}"
    try:
        result = runner(
            ["launchctl", "print", f"{domain}/{LABEL}"],
            check=False,
            capture_output=True,
            text=True,
        )
        loaded = result.returncode == 0
    except FileNotFoundError:
        loaded = False
    return {"installed": destination.is_file(), "loaded": loaded}


def remove_schedule(
    destination: Path,
    *,
    runner: Runner = subprocess.run,
    user_id: int | None = None,
) -> None:
    domain = f"gui/{os.getuid() if user_id is None else user_id}"
    runner(
        ["launchctl", "bootout", domain, str(destination)],
        check=False,
        capture_output=True,
        text=True,
    )
    destination.unlink(missing_ok=True)
