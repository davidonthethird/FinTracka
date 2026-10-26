from __future__ import annotations

import argparse
import secrets
import subprocess
import sys
import threading
from pathlib import Path

from fintracka.api import create_app
from fintracka.backups import backup_database, restore_database
from fintracka.db import connect, migrate
from fintracka.exports import export_excel, export_google
from fintracka.google_sheets import build_google_gateway, configure_google
from fintracka.keychain import KeychainSecrets
from fintracka.launchd import install_schedule, remove_schedule, schedule_status
from fintracka.locks import ProcessLock
from fintracka.plaid_service import build_plaid_adapter, configure_plaid, sync_plaid_connections
from fintracka.synthetic import create_synthetic_ledger, synthetic_batches
from fintracka.sync import apply_batch


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    data_directory = args.data_dir.expanduser().resolve()
    data_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    data_directory.chmod(0o700)
    database_path = data_directory / "fintracka.sqlite3"
    lock_path = data_directory / "fintracka.lock"
    if args.command == "serve":
        import uvicorn

        bootstrap = secrets.token_urlsafe(32)
        url = f"http://127.0.0.1:{args.port}/#bootstrap={bootstrap}"
        print(f"Open {url}")
        static_dir = Path(__file__).parent.parent.parent / "frontend" / "dist"
        app = create_app(
            database_path,
            bootstrap_token=bootstrap,
            static_directory=static_dir if static_dir.is_dir() else None,
        )
        if args.open_chrome:
            timer = threading.Timer(0.75, _open_in_chrome, args=(url,))
            timer.daemon = True
            timer.start()
        uvicorn.run(app, host="127.0.0.1", port=args.port)
        return 0
    if args.command == "init-synthetic":
        with ProcessLock(lock_path):
            connection = connect(database_path)
            migrate(connection)
            connection_ids = create_synthetic_ledger(connection, demo=True)
            for connection_id, batch in synthetic_batches(connection_ids).items():
                apply_batch(connection, connection_id, batch)
            connection.close()
        return 0
    if args.command == "configure" and args.provider == "plaid":
        secret = sys.stdin.readline().strip()
        if not secret:
            parser.error("Plaid secret must be provided on stdin")
        with ProcessLock(lock_path):
            connection = connect(database_path)
            try:
                migrate(connection)
                configure_plaid(
                    connection,
                    KeychainSecrets(),
                    args.profile,
                    args.environment,
                    args.client_id,
                    secret,
                )
            finally:
                connection.close()
        print(
            f"Plaid {args.profile.title()} {args.environment} credentials stored in macOS Keychain."
        )
        return 0
    if args.command == "configure" and args.provider == "google":
        client_configuration = sys.stdin.read().strip()
        if not client_configuration:
            parser.error("Google desktop OAuth client JSON must be provided on stdin")
        with ProcessLock(lock_path):
            connection = connect(database_path)
            try:
                migrate(connection)
                configure_google(connection, KeychainSecrets(), client_configuration)
            finally:
                connection.close()
        print("Google desktop OAuth configuration stored in macOS Keychain.")
        return 0
    if args.command == "sync":
        with ProcessLock(lock_path):
            connection = connect(database_path)
            try:
                migrate(connection)
                keychain = KeychainSecrets()
                runs = sync_plaid_connections(
                    connection,
                    lambda profile, environment: build_plaid_adapter(
                        connection, keychain, profile, environment
                    ),
                )
            finally:
                connection.close()
        print(f"Completed {len(runs)} Plaid connection sync(s).")
        return 0
    if args.command == "export" and args.export_type == "excel":
        if args.output is None:
            parser.error("Excel export requires --output")
        with ProcessLock(lock_path):
            connection = connect(database_path)
            migrate(connection)
            export_excel(connection, args.output)
            connection.close()
        return 0
    if args.command == "export" and args.export_type in {"sheets", "google_sheets"}:
        with ProcessLock(lock_path):
            connection = connect(database_path)
            try:
                migrate(connection)
                export_google(connection, build_google_gateway(connection, KeychainSecrets()))
            finally:
                connection.close()
        return 0
    if args.command == "backup":
        with ProcessLock(lock_path):
            backup_database(database_path, args.output_dir)
        return 0
    if args.command == "restore":
        with ProcessLock(lock_path):
            restore_database(args.backup, database_path, verify=args.verify)
        return 0
    if args.command == "schedule":
        destination = Path.home() / "Library" / "LaunchAgents" / "com.fintracka.sync.plist"
        if args.schedule_action == "install":
            install_schedule(destination, Path(sys.executable), data_directory)
            print("Daily sync schedule installed for 06:17 local time and login.")
        elif args.schedule_action == "status":
            status = schedule_status(destination)
            words = "installed" if status["installed"] else "not installed"
            words += " and loaded" if status["loaded"] else " and not loaded"
            print(f"Daily sync schedule is {words}.")
        else:
            remove_schedule(destination)
            print("Daily sync schedule removed.")
        return 0
    parser.error("unsupported command")
    return 2


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fintracka")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve")
    serve.add_argument("--data-dir", type=Path, default=_default_data_directory())
    serve.add_argument("--port", type=int, default=8787)
    serve.add_argument("--open-chrome", action="store_true")
    synthetic = subparsers.add_parser("init-synthetic")
    synthetic.add_argument("--data-dir", type=Path, default=_default_data_directory())
    configure = subparsers.add_parser("configure")
    configure_subparsers = configure.add_subparsers(dest="provider", required=True)
    plaid = configure_subparsers.add_parser("plaid")
    plaid.add_argument("--data-dir", type=Path, default=_default_data_directory())
    plaid.add_argument("--profile", choices=["david", "ariela"], default="david")
    plaid.add_argument("--environment", choices=["sandbox", "production"], required=True)
    plaid.add_argument("--client-id", required=True)
    plaid.add_argument("--secret-stdin", action="store_true", required=True)
    google = configure_subparsers.add_parser("google")
    google.add_argument("--data-dir", type=Path, default=_default_data_directory())
    google.add_argument("--client-json-stdin", action="store_true", required=True)
    sync = subparsers.add_parser("sync")
    sync.add_argument("--data-dir", type=Path, default=_default_data_directory())
    export = subparsers.add_parser("export")
    export.add_argument("export_type", choices=["excel", "sheets", "google_sheets"])
    export.add_argument("--data-dir", type=Path, default=_default_data_directory())
    export.add_argument("--output", type=Path)
    backup = subparsers.add_parser("backup")
    backup.add_argument("--data-dir", type=Path, default=_default_data_directory())
    backup.add_argument("--output-dir", type=Path, required=True)
    restore = subparsers.add_parser("restore")
    restore.add_argument("backup", type=Path)
    restore.add_argument("--data-dir", type=Path, default=_default_data_directory())
    restore.add_argument("--verify", action="store_true")
    schedule = subparsers.add_parser("schedule")
    schedule.add_argument("schedule_action", choices=["install", "status", "remove"])
    schedule.add_argument("--data-dir", type=Path, default=_default_data_directory())
    return parser


def _default_data_directory() -> Path:
    return Path.home() / "Library" / "Application Support" / "FinTracka"


def _open_in_chrome(url: str) -> None:
    subprocess.Popen(["open", "-a", "Google Chrome", url])


if __name__ == "__main__":
    sys.exit(main())
