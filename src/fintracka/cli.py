from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from fintracka.api import create_app
from fintracka.backups import backup_database, restore_database
from fintracka.db import connect, migrate
from fintracka.exports import export_excel, export_google
from fintracka.google_sheets import build_google_gateway, configure_google
from fintracka.keychain import KeychainSecrets
from fintracka.launchd import (
    install_remote_schedule,
    install_schedule,
    remote_schedule_status,
    remove_remote_schedule,
    remove_schedule,
    schedule_status,
)
from fintracka.locks import ProcessLock
from fintracka.plaid_service import build_plaid_adapter, configure_plaid, sync_plaid_connections
from fintracka.remote_config import configure_remote, load_remote_settings, set_remote_enabled
from fintracka.remote_client import RemotePublishError
from fintracka.remote_service import publish_remote_snapshot, purge_remote_snapshots
from fintracka.remote_snapshot import build_remote_snapshot, serialize_remote_snapshot, snapshot_digest
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
    if args.command == "configure" and args.provider == "remote":
        secret = sys.stdin.readline().strip()
        if not secret:
            parser.error("Access client secret must be provided on stdin")
        with ProcessLock(lock_path):
            connection = connect(database_path)
            try:
                migrate(connection)
                configure_remote(
                    connection,
                    KeychainSecrets(),
                    viewer_url=args.viewer_url,
                    publisher_url=args.publisher_url,
                    access_client_id=args.client_id,
                    access_client_secret=secret,
                    history_months=args.history_months,
                    interval_minutes=args.interval_minutes,
                )
            finally:
                connection.close()
        print("Remote viewer configured; automatic publication remains disabled until remote enable.")
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
        try:
            publish_remote_snapshot(database_path, KeychainSecrets(), reason="sync")
        except RemotePublishError as error:
            print(f"Remote publication failed ({error.code}); bank sync still succeeded.", file=sys.stderr)
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
    if args.command == "remote" and args.remote_action == "preview":
        with ProcessLock(lock_path):
            connection = connect(database_path)
            try:
                migrate(connection)
                settings = load_remote_settings(connection)
                snapshot = build_remote_snapshot(
                    connection,
                    source_sequence=settings.next_source_sequence,
                    history_months=settings.history_months,
                    now=datetime.now(timezone.utc),
                )
                payload = serialize_remote_snapshot(snapshot)
            finally:
                connection.close()
        if args.output:
            descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                output.write(payload + b"\n")
        print(json.dumps({
            "transactions": snapshot.counts.transactions,
            "sources": snapshot.counts.sources,
            "history_start": snapshot.history_start,
            "history_end": snapshot.history_end,
            "bytes": len(payload),
            "digest": snapshot_digest(payload),
        }, sort_keys=True))
        return 0
    if args.command == "remote" and args.remote_action == "publish":
        result = publish_remote_snapshot(database_path, KeychainSecrets(), reason=args.reason)
        print("Remote publication is disabled." if result is None else f"Published snapshot {result.snapshot_id}.")
        return 0
    if args.command == "remote" and args.remote_action == "status":
        connection = connect(database_path)
        try:
            migrate(connection)
            settings = load_remote_settings(connection)
        finally:
            connection.close()
        print(json.dumps({
            "enabled": settings.enabled,
            "viewer_url": settings.viewer_url,
            "last_snapshot_id": settings.last_snapshot_id,
            "last_published_at": settings.last_published_at,
            "last_error_code": settings.last_error_code,
        }, sort_keys=True))
        return 0
    if args.command == "remote" and args.remote_action in {"enable", "disable"}:
        with ProcessLock(lock_path):
            connection = connect(database_path)
            try:
                migrate(connection)
                settings = set_remote_enabled(connection, args.remote_action == "enable")
            finally:
                connection.close()
        print(
            "Automatic remote publication enabled."
            if settings.enabled
            else "Automatic remote publication disabled."
        )
        return 0
    if args.command == "remote" and args.remote_action == "purge":
        purge_remote_snapshots(database_path, KeychainSecrets())
        print("Remote snapshots purged.")
        return 0
    if args.command == "remote" and args.remote_action == "schedule":
        destination = Path.home() / "Library" / "LaunchAgents" / "com.fintracka.remote-publish.plist"
        if args.schedule_action == "install":
            connection = connect(database_path)
            try:
                migrate(connection)
                interval_minutes = load_remote_settings(connection).interval_minutes
            finally:
                connection.close()
            install_remote_schedule(destination, Path(sys.executable), data_directory, interval_minutes)
            print(f"Remote publication schedule installed every {interval_minutes} minutes.")
        elif args.schedule_action == "status":
            print(json.dumps(remote_schedule_status(destination), sort_keys=True))
        else:
            remove_remote_schedule(destination)
            print("Remote publication schedule removed.")
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
    remote_config = configure_subparsers.add_parser("remote")
    remote_config.add_argument("--data-dir", type=Path, default=_default_data_directory())
    remote_config.add_argument("--viewer-url", required=True)
    remote_config.add_argument("--publisher-url", required=True)
    remote_config.add_argument("--client-id", required=True)
    remote_config.add_argument("--secret-stdin", action="store_true", required=True)
    remote_config.add_argument("--history-months", type=int, choices=range(1, 7), default=6)
    remote_config.add_argument("--interval-minutes", type=int, default=60)
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
    remote = subparsers.add_parser("remote")
    remote_subparsers = remote.add_subparsers(dest="remote_action", required=True)
    remote_preview = remote_subparsers.add_parser("preview")
    remote_preview.add_argument("--data-dir", type=Path, default=_default_data_directory())
    remote_preview.add_argument("--output", type=Path)
    remote_publish = remote_subparsers.add_parser("publish")
    remote_publish.add_argument("--data-dir", type=Path, default=_default_data_directory())
    remote_publish.add_argument("--reason", choices=["manual", "scheduled"], default="manual")
    remote_status = remote_subparsers.add_parser("status")
    remote_status.add_argument("--data-dir", type=Path, default=_default_data_directory())
    remote_enable = remote_subparsers.add_parser("enable")
    remote_enable.add_argument("--data-dir", type=Path, default=_default_data_directory())
    remote_disable = remote_subparsers.add_parser("disable")
    remote_disable.add_argument("--data-dir", type=Path, default=_default_data_directory())
    remote_purge = remote_subparsers.add_parser("purge")
    remote_purge.add_argument("--data-dir", type=Path, default=_default_data_directory())
    remote_purge.add_argument("--confirm-delete-remote-snapshot", action="store_true", required=True)
    remote_schedule = remote_subparsers.add_parser("schedule")
    remote_schedule.add_argument("schedule_action", choices=["install", "status", "remove"])
    remote_schedule.add_argument("--data-dir", type=Path, default=_default_data_directory())
    return parser


def _default_data_directory() -> Path:
    return Path.home() / "Library" / "Application Support" / "FinTracka"


def _open_in_chrome(url: str) -> None:
    subprocess.Popen(["open", "-a", "Google Chrome", url])


if __name__ == "__main__":
    sys.exit(main())
