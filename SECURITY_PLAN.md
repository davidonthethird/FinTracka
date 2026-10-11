# Security Plan

## Current evidence and design status

At approval time the repository contained development-environment notes only. The controls below are requirements for implementation, not claims about existing application code. The threat model must be updated with file/symbol evidence before live use.

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

### High: retry or interruption corrupts the ledger

Use stable external IDs, complete-page staging, atomic data/checkpoint commit, database constraints, provider versions, audit events, and verified backups.

### High: laptop or backup disclosure

FileVault is a live-data prerequisite. Application data and backups use mode `0600`; directories use `0700`. Off-device copies use encrypted Time Machine or encrypted APFS. No custom cryptography is introduced.

### Medium: CSV/provider content injection

Limit CSV to 10 MiB, validate encoding and column mappings, render text without HTML, reject arbitrary URLs/paths, and prefix spreadsheet strings beginning with formula characters.

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

