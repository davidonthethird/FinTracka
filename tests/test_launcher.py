from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _launcher_project(tmp_path: Path, npm_exit: int = 0) -> tuple[Path, dict[str, str], Path]:
    project = tmp_path / "FinTracka"
    scripts = project / "scripts"
    scripts.mkdir(parents=True)
    launcher = scripts / "launch_fintracka.command"
    shutil.copy2(ROOT / "scripts" / "launch_fintracka.command", launcher)
    launcher.chmod(0o755)

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "curl").write_text("#!/bin/sh\nexit 1\n")
    (fake_bin / "npm").write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NPM_LOG\"\n"
        f"exit {npm_exit}\n"
    )
    for executable in fake_bin.iterdir():
        executable.chmod(0o755)

    python = project / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("#!/bin/sh\nexit 0\n")
    python.chmod(0o755)

    npm_log = tmp_path / "npm.log"
    environment = os.environ.copy()
    environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
    environment["NPM_LOG"] = str(npm_log)
    return launcher, environment, npm_log


def test_launcher_refreshes_dependencies_before_building(tmp_path: Path) -> None:
    launcher, environment, npm_log = _launcher_project(tmp_path)

    result = subprocess.run(
        [launcher], input="\n", text=True, capture_output=True,
        env=environment, timeout=10,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert npm_log.read_text().splitlines() == [
        "--prefix frontend install --no-audit --no-fund",
        "--prefix frontend run build",
    ]


def test_launcher_reports_build_failure_without_zsh_reserved_variable_error(
    tmp_path: Path,
) -> None:
    launcher, environment, _ = _launcher_project(tmp_path, npm_exit=7)

    result = subprocess.run(
        [launcher], input="\n", text=True, capture_output=True,
        env=environment, timeout=10,
    )

    output = result.stdout + result.stderr
    assert result.returncode == 7
    assert "FinTracka could not start. Press Return to close." in output
    assert "read-only variable" not in output
