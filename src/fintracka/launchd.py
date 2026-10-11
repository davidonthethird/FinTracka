from __future__ import annotations

import plistlib
from pathlib import Path


def build_launch_agent(python: Path, data_directory: Path) -> bytes:
    logs = data_directory / "logs"
    return plistlib.dumps(
        {
            "Label": "com.fintracka.sync",
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
    destination.write_bytes(build_launch_agent(python, data_directory))
    destination.chmod(0o600)
    return destination

