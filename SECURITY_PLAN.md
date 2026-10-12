# Security Plan

## Current evidence and design status

The synthetic-data release is implemented and verified as of 2026-10-11. This document now distinguishes implemented controls from live-rollout gates. No production provider or Google credential has been used.

Implemented evidence:

- `security.LocalSessions` exchanges a one-use fragment token for an in-memory session; `api.local_security` enforces Host, Origin, CSRF, and session checks and adds CSP, no-sniff, no-referrer, and no-store headers.
- `db.connect` enables foreign keys, WAL, a five-second busy timeout, request-safe FastAPI thread handoff, and owner-only `0600` database/WAL permissions. Migrations contain the ledger checks and uniqueness constraints.
- `sync.apply_batch` commits provider facts, aliases, audit versions, tombstones, rules, and the checkpoint in one `BEGIN IMMEDIATE` transaction.
- `keychain.KeychainSecrets` and `connection_secret_refs` keep provider token values outside SQLite. Plaid tests verify that completion responses do not expose access tokens.
- `exports.export_excel` validates a temporary workbook before atomic replacement, applies formula-injection escaping, and sets `0600`. Google export remains behind a fake-tested narrow gateway.
- `backups.backup_database` uses SQLite online backup, `integrity_check`, atomic replacement, `0600`, and retention. API exports and backups use fixed application-owned directories rather than caller-supplied paths.
- The React client does not store ledger data or secrets in browser storage; only the theme preference is persistent. The session cookie is HttpOnly and SameSite-Strict.
- Python, TypeScript, browser, dependency, and real-Uvicorn checks are collected by `scripts/verify.sh` and the test suites; release review also runs a tracked-file secret-pattern scan.

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

FileVault is a live-data prerequisite. Application data and backups use mode `0600`; directories use `0700`. Off-device copies use encrypted Time Machine or encrypted APFS. No custom cryptography is introduced.

### Medium: CSV/provider content injection

Limit CSV to 5 MiB, validate UTF-8 and required columns, render text through React escaping, reject arbitrary output paths, and prefix spreadsheet strings beginning with formula characters.

### Medium: Google workbook exposure

Use the per-file `drive.file` scope, create one FinTracka workbook, never auto-share it, protect app-owned ranges, and show a persistent sensitivity warning. Google permissions remain a user-controlled residual risk.

### Medium: dependency compromise

Pin direct dependencies, retain lockfiles, run package audits before live rollout, avoid general component frameworks, and permit runtime third-party scripts only for the bank connection widget.

## Logging

Allowed fields: local run/job ID, provider name, operation, sanitized error code, request ID, counts, duration, and timestamps. Prohibited fields: secrets, raw API bodies, transaction text, amounts, balances, account masks, OAuth payloads, and local-user paths beyond the application data directory.

## Backups and deletion

Use SQLite online backup, `integrity_check`, fsync, and atomic replace. Keep 30 daily local backups. Provider disconnect preserves records. Permanent erasure requires a separately confirmed operation that deletes database rows, backups selected by the user, exports, and Keychain items.

## Residual risk

Malware executing as the logged-in macOS user can potentially read displayed data or request Keychain access. A localhost-only design reduces network exposure but cannot secure a compromised host.

## Live-data gate and open security work

Synthetic and Plaid Sandbox use are permitted. Real financial data remains blocked until all of the following are independently verified:

- Install a security-current Python 3.14.x, rebuild `.venv`, reinstall locked dependencies, and rerun `scripts/verify.sh`.
- Confirm FileVault is enabled and the selected off-device Time Machine/APFS destination is encrypted.
- Run a provider-coverage and current-pricing review, obtain explicit live-rollout approval, connect one institution, and reconcile it to a statement for at least seven days.
- Configure production provider and Google credentials only through Keychain. The current application does not expose live Link or Google OAuth controls.
- Run a dependency-vulnerability review for the exact release lockfiles and inspect any newly introduced runtime scripts.

Remaining medium risks are deliberate release boundaries: localhost HTTP has no TLS because it is loopback-only; Google sharing is outside FinTracka's control after export; the Google production gateway and launch-agent installer are not enabled; and account/transaction deletion is intentionally absent so disconnect cannot erase audit history.
