from __future__ import annotations

import argparse
import secrets
import sys
from pathlib import Path

from fintracka.api import create_app
from fintracka.backups import backup_database, restore_database
from fintracka.db import connect, migrate
from fintracka.exports import export_excel
from fintracka.keychain import KeychainSecrets
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
        print(f"Open http://127.0.0.1:{args.port}/#bootstrap={bootstrap}")
        uvicorn.run(create_app(database_path, bootstrap_token=bootstrap), host="127.0.0.1", port=args.port)
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
                    args.environment,
                    args.client_id,
                    secret,
                )
            finally:
                connection.close()
        print(f"Plaid {args.environment} credentials stored in macOS Keychain.")
        return 0
    if args.command == "sync":
        with ProcessLock(lock_path):
            connection = connect(database_path)
            try:
                migrate(connection)
                adapter = build_plaid_adapter(connection, KeychainSecrets())
                runs = sync_plaid_connections(connection, adapter)
            finally:
                connection.close()
        print(f"Completed {len(runs)} Plaid connection sync(s).")
        return 0
    if args.command == "export" and args.export_type == "excel":
        with ProcessLock(lock_path):
            connection = connect(database_path)
            migrate(connection)
            export_excel(connection, args.output)
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
    parser.error("unsupported command")
    return 2


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fintracka")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve")
    serve.add_argument("--data-dir", type=Path, default=_default_data_directory())
    serve.add_argument("--port", type=int, default=8787)
    synthetic = subparsers.add_parser("init-synthetic")
    synthetic.add_argument("--data-dir", type=Path, default=_default_data_directory())
    configure = subparsers.add_parser("configure")
    configure_subparsers = configure.add_subparsers(dest="provider", required=True)
    plaid = configure_subparsers.add_parser("plaid")
    plaid.add_argument("--data-dir", type=Path, default=_default_data_directory())
    plaid.add_argument("--environment", choices=["sandbox", "production"], required=True)
    plaid.add_argument("--client-id", required=True)
    plaid.add_argument("--secret-stdin", action="store_true", required=True)
    sync = subparsers.add_parser("sync")
    sync.add_argument("--data-dir", type=Path, default=_default_data_directory())
    export = subparsers.add_parser("export")
    export.add_argument("export_type", choices=["excel"])
    export.add_argument("--data-dir", type=Path, default=_default_data_directory())
    export.add_argument("--output", type=Path, required=True)
    backup = subparsers.add_parser("backup")
    backup.add_argument("--data-dir", type=Path, default=_default_data_directory())
    backup.add_argument("--output-dir", type=Path, required=True)
    restore = subparsers.add_parser("restore")
    restore.add_argument("backup", type=Path)
    restore.add_argument("--data-dir", type=Path, default=_default_data_directory())
    restore.add_argument("--verify", action="store_true")
    return parser


def _default_data_directory() -> Path:
    return Path.home() / "Library" / "Application Support" / "FinTracka"


if __name__ == "__main__":
    sys.exit(main())
