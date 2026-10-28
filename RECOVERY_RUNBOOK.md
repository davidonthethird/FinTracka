# FinTracka recovery runbook

FinTracka's SQLite database is the authoritative ledger. Do not initialize Savings goals, migrate a live database, or experiment with recovery until a verified copy exists.

## Back up before Savings activation

```sh
.venv/bin/python -m fintracka.cli backup \
  --output-dir "$HOME/Library/Application Support/FinTracka/backups"
```

Keep the generated backup and verification result. In Savings, review the initialization preview before confirming: up to $25,000 goes to Emergency, the remainder goes to General Savings, and setup starts in the selected current month without backfill.

## Restore

1. Turn FinTracka off and keep the damaged database unchanged for investigation.
2. Copy the chosen backup to a separate temporary path and verify it first.
3. Restore with:

```sh
.venv/bin/python -m fintracka.cli restore /private/path/backup.sqlite3 --verify
```

4. Launch FinTracka, check Settings readiness, account balances, Savings reconciliation, and the latest transactions before syncing.

Savings events are append-only. Use the UI's undo action for a mistaken eligible adjustment; do not edit `savings_ledger_entries` manually. A Pending-transfer mismatch means money is still awaiting a matching withdrawal or manual assignment, not that FinTracka should invent a balancing entry.

Pershing remains unsupported for now. Leave it unassigned until a real connection is added and reviewed.

## Remote viewer containment

The hosted snapshot is not a backup and cannot restore SQLite. A local restore does not update the hosted copy until a later successful publication.

If remote access may be compromised, remove the hourly publication schedule, purge the hosted snapshot, and revoke its Access service token. If the Mac is unavailable, revoke the token and both Access applications in Cloudflare, then empty the R2 bucket from the dashboard. Follow the exact sequence and deletion limitations in [REMOTE_VIEWER_RUNBOOK.md](REMOTE_VIEWER_RUNBOOK.md).
