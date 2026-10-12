# Security Plan

## Current evidence and design status

The live-testing implementation is complete as of 2026-10-12. Automated tests remain synthetic; production credentials stay in macOS Keychain and a real institution is connected only through the interactive Plaid Link flow. See `FinTracka-threat-model.md` for the repository-grounded abuse-path review.

Implemented evidence:

- `security.LocalSessions` exchanges a one-use fragment token for an in-memory session; `api.local_security` enforces Host, Origin, CSRF, and session checks and adds environment-specific CSP, frame denial, Permissions-Policy, no-sniff, no-referrer, and no-store headers. Interactive API documentation is disabled.
- `db.connect` enables foreign keys, WAL, a five-second busy timeout, request-safe FastAPI thread handoff, and owner-only `0600` database/WAL permissions. Migrations contain the ledger checks and uniqueness constraints.
- `sync.apply_batch` commits provider facts, aliases, audit versions, tombstones, rules, and the checkpoint in one `BEGIN IMMEDIATE` transaction.
- `keychain.KeychainSecrets` and `connection_secret_refs` keep provider token values outside SQLite. Plaid tests verify that completion responses do not expose access tokens.
- `exports.export_excel` validates a temporary workbook before atomic replacement, applies formula-injection escaping, and sets `0600`. Google uses official clients, desktop authorization, the narrow `drive.file` scope, and Keychain-held refresh credentials.
- `backups.backup_database` uses SQLite online backup, `integrity_check`, atomic replacement, `0600`, and retention. API exports and backups use fixed application-owned directories rather than caller-supplied paths.
- Optimistic version checks, mutations, and audit rows share one `BEGIN IMMEDIATE` transaction; a concurrent-request regression proves that only one writer can consume an expected version.
- The React client does not store ledger data or secrets in browser storage; only the theme preference is persistent. The session cookie is HttpOnly and SameSite-Strict.
- Python 3.14, TypeScript, browser, dependency, and real-Uvicorn checks are collected by `scripts/verify.sh`. `scripts/scan_local_secrets.py` compares Keychain-held values without printing them against the worktree, local data files, and Git history.

## Assets

- Provider access tokens, Plaid secrets, Google refresh tokens, and Teller certificates.
- Transaction descriptions, balances, account metadata, notes, categories, and budgets.
- Ledger integrity, sync checkpoints, audit history, backups, and export targets.

## Trust boundaries

- Browser to localhost API over HTTP: ephemeral session, strict Host/Origin, CSRF, CSP, schema validation.
- Backend to provider/Google over TLS: official client or `httpx` certificate validation, least-privilege products/scopes, bounded retries.
- Backend to SQLite/files: restrictive permissions, fixed application-owned paths, atomic replacement.
- Backend to Keychain: secret values never copied to database or logs.
- SQLite to Google/Excel: deliberate export of sensitive data with formula-injection protection.

## Threats and mitigations

### High: provider or OAuth token disclosure

Store secrets only in macOS Keychain. Database rows contain service/account references. Redact headers, URLs, payloads, account masks, descriptions, amounts, and tokens from logs. Disconnect revokes provider access before deleting the local secret.

### High: malicious website attacks localhost

Bind only `127.0.0.1`; reject unapproved Host and Origin; disable CORS; exchange a one-use startup token for an HttpOnly SameSite-Strict cookie; require CSRF on every mutation; use explicit Pydantic bodies with extra fields rejected.

Abuse path: a hostile webpage attempts a blind localhost POST or DNS-rebinding request. It cannot read the fragment bootstrap token, session cookie, or CSRF token; an unapproved Host/Origin or missing token is rejected before the route runs. A malicious process already running as the logged-in user remains in the host-compromise residual-risk class.

### High: retry or interruption corrupts the ledger

Use stable external IDs, complete-page staging, atomic data/checkpoint commit, database constraints, provider versions, audit events, and verified backups.

Abuse path: a provider repeats, mutates, or interrupts pages while advancing its cursor. Stable aliases and the checkpoint/data transaction prevent duplicate canonicals or cursor-only progress; Plaid mutation errors restart from the original cursor.

### High: laptop or backup disclosure

FileVault is a live-data prerequisite. Application data and backups use mode `0600`; directories use `0700`. A verified local backup is created before the first Production Link session and 30 daily copies are retained. During testing, the missing off-device backup is a prominent non-blocking warning and an explicitly accepted hardware-loss risk. No custom cryptography is introduced.

### Medium: CSV/provider content injection

Limit CSV to 5 MiB, validate UTF-8 and required columns, render text through React escaping, reject arbitrary output paths, and prefix spreadsheet strings beginning with formula characters.

### Medium: Google workbook exposure

Use the per-file `drive.file` scope, create one FinTracka workbook, never auto-share it, protect app-owned ranges, and show a persistent sensitivity warning. Google permissions remain a user-controlled residual risk.

### Medium: dependency compromise

Pin direct dependencies, retain lockfiles, run package audits before live rollout, avoid general component frameworks, and permit runtime third-party scripts only for the bank connection widget.

## Logging

Allowed fields: local run/job ID, provider name, operation, sanitized error code, request ID, counts, duration, and timestamps. Prohibited fields: secrets, raw API bodies, transaction text, amounts, balances, account masks, OAuth payloads, and local-user paths beyond the application data directory.

## Backups and deletion

Use SQLite online backup, `integrity_check`, file/directory fsync, and atomic replace. Keep the newest verified backup for each of the latest 30 UTC days. Provider disconnect preserves records. Permanent erasure requires a separately confirmed operation that deletes database rows, backups selected by the user, exports, and Keychain items.

## Residual risk

Malware executing as the logged-in macOS user can potentially read displayed data or request Keychain access. A localhost-only design reduces network exposure but cannot secure a compromised host.

## Live-testing gate

The Settings readiness panel enforces Python 3.14, FileVault, a readable Keychain, Plaid Production credentials, and a verified local backup. Google authorization, launchd scheduling, last-sync recency, and off-device backup are reported separately as advisory state.

The approved rollout is one institution first, account/balance comparison, an exact statement reconciliation, and seven days of observation before another institution is added. Full verification, dependency audits, and the local secret scan run before a public push. Credentialed Plaid and Google smoke tests run only on this Mac and never in GitHub Actions.

Remaining deliberate boundaries: localhost HTTP has no TLS because it is loopback-only; Google sharing is outside FinTracka's control after export; an off-device backup is not yet configured; Plaid's required hosted Link script is trusted through a narrow CSP allowlist rather than a fixed SRI hash; and disconnect cannot erase audit history.
