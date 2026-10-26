# Multi-Plaid Credential Profiles Design

## Intent

FinTracka will support two separately configured Plaid developer credential profiles, `david` and `ariela`, while retaining one shared SQLite ledger, one localhost application, and one set of household reports. Each Plaid Item will be permanently associated with the credential profile that created it so Link completion, synchronization, repair, and revocation always use the matching Plaid client ID and secret.

This change supports a second separately owned Plaid developer team. It does not create that team, establish its Trial eligibility, or change Plaid's terms or limits.

## Goals

- Configure David and Ariela independently through the local CLI.
- Keep both client IDs, secrets, and Item access tokens exclusively in macOS Keychain.
- Let the user explicitly choose David or Ariela before opening Plaid Link.
- Bind every new Plaid connection to the chosen credential profile.
- Route completion, repair, revocation, manual sync, startup sync, and scheduled sync through the connection's stored profile.
- Preserve every existing connection, cursor, account, transaction, category, and user edit without reconnecting; existing Plaid configuration and connections become David's profile.
- Show the credential profile on the Connections page without exposing credentials.
- Preserve the existing provider-neutral ledger and combined household reporting.

## Non-goals

- Plaid Investments, Roth IRA holdings, securities, or investment transactions. Those require a separate design and implementation.
- Creating or managing Plaid Dashboard accounts or teams from FinTracka.
- Guaranteeing that Plaid grants a second Trial plan.
- Arbitrary numbers of credential profiles, profile creation UI, profile deletion, or profile renaming.
- Moving an existing Plaid Item between developer profiles. Plaid Items remain owned by the credentials that created them.
- Separate ledgers, multiple FinTracka users, cloud sync, or remote access.
- Deriving spending ownership from the credential profile. Account spending ownership remains independent and editable.

## Constraints

- The application remains single-user and localhost-only.
- SQLite remains authoritative for financial data and stores only Keychain reference names.
- No Plaid client ID, secret, access token, public token, OAuth payload, or raw provider response may enter SQLite, logs, browser storage, screenshots, API responses, Git, or CI.
- Both profiles support `sandbox` or `production`; each connection records both its profile and environment.
- Existing connections must continue syncing without user action after migration.
- A connection must never fall back to the other profile when its configured credentials are missing.
- Tests remain synthetic and use fake credentials and provider clients.

## Approaches considered

### Selected: two fixed credential profiles in one ledger

Add `david` and `ariela` as stable profile identifiers, retain one SQLite ledger, and bind each Plaid connection to exactly one profile. This is the smallest approach that keeps household reporting unified and ensures every provider action uses the correct credentials.

### Rejected: two independent FinTracka data directories

Separate installations would isolate credentials but split transactions, transfers, categories, planning, and reports. Recombining them would require a new synchronization or merge system and would undermine the shared-ledger requirement.

### Rejected: swap one global credential set before each operation

Credential swapping cannot support unattended synchronization, makes repair and revocation error-prone, and creates a credible risk of attempting an Item operation with the wrong Plaid client. It also provides no durable audit trail of which profile owns a connection.

## Data design

A numbered migration adds `credential_profile` to `provider_connections`:

- Values are limited to `david` or `ariela`.
- The non-null default is `david`, which migrates all existing Plaid connections without changing their IDs or provider cursors.
- Synthetic and manual connections also retain the default value, but the field is ignored unless `provider = 'plaid'`.

Profile configuration remains in `app_metadata`, with values containing only Keychain reference names:

- `plaid.profile.david.environment`
- `plaid.profile.david.<environment>.client_id_ref`
- `plaid.profile.david.<environment>.secret_ref`
- the corresponding `ariela` keys

New Keychain account names are profile-scoped:

- `plaid:profile:david:<environment>:client_id`
- `plaid:profile:david:<environment>:secret`
- `plaid:profile:ariela:<environment>:client_id`
- `plaid:profile:ariela:<environment>:secret`

The migration copies the existing global David environment plus every existing Sandbox and Production Keychain reference into the new David metadata keys. It does not read, copy, print, or rewrite any secret. The existing Keychain references remain valid, so no live Item is relinked.

New configurations use unique, versioned Keychain account references rather than overwriting a working credential in place. Configuration writes the new client ID and secret first, commits metadata that points to both new references, and removes the newly written entries if the database commit fails. After a successful commit, superseded Keychain entries may be removed on a best-effort basis; failure to remove an obsolete Keychain entry does not invalidate the active configuration. The reference shape is `plaid:profile:<profile>:<environment>:<kind>:<configuration_uuid>`.

Connection access-token references remain keyed by connection UUID. Their existing names do not need to change because the connection row supplies the credential profile used to build the Plaid client.

## Service behavior

`PlaidProfile` is the closed set `Literal["david", "ariela"]`. Configuration loading and adapter construction require an explicit profile and environment. There is no implicit fallback between profiles or environments.

Each profile has a selected environment used only for new Link sessions. Existing connection operations use the connection row's stored profile and stored environment, even if the profile's selected environment later changes. `build_plaid_adapter(connection, secrets, profile, environment=None, client_factory=...)` uses the profile's selected environment only when `environment` is omitted; repair, revoke, and sync always pass the stored environment.

Creating a connection follows this sequence:

1. The UI sends the selected profile when requesting a Link session.
2. The backend loads only that profile's Keychain credentials and creates Link.
3. The UI retains the selected profile in React state for that Link attempt; it does not persist credentials or the public token.
4. Link completion sends the short-lived public token and selected profile to the backend.
5. The backend exchanges the token using only that profile's adapter and writes `credential_profile` with the new connection in the same database transaction as its institution and Keychain reference.
6. If Keychain or database persistence fails, the newly created Item is revoked using the same profile adapter and partial secret material is removed under the existing cleanup guarantees.

Repair and revocation do not accept a caller-selected profile. The service first reads the connection's stored profile and environment, constructs that profile's adapter, then performs the provider action. A revoked connection retains its profile for audit history.

Synchronization loads each active connection's stored profile and environment, constructs or reuses the matching adapter for that profile/environment pair during the run, and retains the existing atomic cursor-and-ledger commit behavior. It attempts every active connection even when one profile is unavailable. Successful connections commit normally; each failed connection records a sanitized error code without advancing its checkpoint. After all connections have been attempted, any failures raise one sanitized aggregate error so the persisted job is visibly failed while successful connections remain updated. Missing or invalid credentials must never trigger a retry with another profile or environment.

The CLI becomes:

```text
fintracka configure plaid --profile david --environment production --client-id … --secret-stdin
fintracka configure plaid --profile ariela --environment production --client-id … --secret-stdin
```

`--profile` defaults to `david` for compatibility with existing local setup instructions. CLI output identifies only the profile and environment and never echoes a credential.

## API changes

- `GET /api/v1/providers` returns Plaid with two sanitized profile-status objects: profile ID, display label, configured boolean, and environment when configured.
- `POST /api/v1/connections/plaid/sessions` requires `{ "profile": "david" | "ariela" }`.
- `POST /api/v1/connections/plaid/complete` requires `{ "public_token": "…", "profile": "david" | "ariela" }`.
- `GET /api/v1/connections` adds `credential_profile` for Plaid rows.
- `POST /api/v1/connections/{id}/repair` and `DELETE /api/v1/connections/{id}` retain their contracts and derive the profile from SQLite.
- `POST /api/v1/sync-runs` retains its contract and synchronizes all active Plaid connections with their respective profiles.

All request models remain strict and reject unknown profile values and unexpected fields. Responses never include Keychain references, client IDs, secrets, public tokens, access tokens, or raw Plaid payloads.

## UI behavior

The Connections page shows one Plaid provider section with two compact rows:

- `David · Production` with `Connect bank`
- `Ariela · Production` with `Connect bank`

An unconfigured profile shows `Not configured` and a disabled button. Each connected-source row and detail dialog shows `Plaid profile: David` or `Plaid profile: Ariela`. The existing institution status, sync, repair, account-management, and disconnect controls remain unchanged.

The credential profile is provider routing metadata, not financial ownership. Connecting through Ariela does not automatically change an account's `spending_owner`; the user continues to set David, Ariela, or Shared from Accounts.

No profile choice is added to transactions, planning, savings, reports, exports, or reconciliation because those operate on the shared canonical ledger.

## Readiness and security

Readiness reports David and Ariela separately. A profile can connect only when its selected environment's client ID and secret resolve from Keychain. An unconfigured profile with no active connections is a non-blocking warning and leaves its Connect button unavailable. Missing credentials for a profile with an active connection are a blocking failure for that profile while other configured profiles remain usable.

At application startup, Content Security Policy generation takes the union of configured Plaid environments so mixed Sandbox and Production profiles work without a wildcard. It keeps the existing narrow Plaid CDN allowances and does not add permissive CORS or wildcard hosts.

Plaid configuration audit events use `entity_id = "plaid:<profile>"`; connection events keep the connection UUID and obtain the profile from the connection row. Existing log redaction rules continue to exclude descriptions, amounts, account masks, OAuth payloads, request bodies, and provider secrets.

## Migration and failure behavior

- Before applying this numbered migration to a file-backed database, the migration runner uses SQLite's online backup API to create and integrity-check a mode-`0600` backup in the existing backup directory. In-memory databases and disposable test databases may use a test-provided backup directory; the production path cannot apply this migration without a verified backup.
- Existing rows receive `david`; existing metadata references are copied, not replaced.
- Existing access-token references, checkpoints, account IDs, transaction IDs, and audit history remain byte-for-byte associated with the same connection IDs.
- Re-running the migration is harmless through the numbered migration mechanism.
- Configuring Ariela cannot modify David's metadata or Keychain references.
- A failed Ariela Link completion revokes only the new Ariela Item and cannot affect David Items.
- Repair or disconnect always uses the profile stored on the target connection; the browser cannot override it.
- A missing Ariela Keychain entry returns a sanitized configuration error and never uses David's credentials.

## Verification

Automated tests will cover:

- Migration of legacy metadata and connections to David without changing financial IDs, rows, cursors, or totals.
- Environment-separated and profile-separated Keychain references with no secret values in SQLite.
- Independent configuration loading and adapter construction for both profiles.
- David and Ariela Link creation and completion using their respective fake clients.
- Cleanup after profile-specific Keychain or database failure.
- Repair and revocation using the stored profile even when another profile is currently configured.
- Mixed-profile and mixed-environment synchronization with atomic checkpoints, continued attempts after one connection fails, a failed aggregate job status, and no cross-profile or cross-environment fallback.
- Missing-profile credentials, invalid profiles, hostile or unexpected JSON fields, CSRF, Origin, and Host enforcement.
- Configuration rollback after Keychain success followed by database failure, proving the prior configuration remains usable and new entries are removed.
- Sanitized provider, connection, readiness, and error responses.
- Playwright coverage for both Connect buttons, profile labels, repair, disconnect, and combined household data.
- CLI compatibility with omitted `--profile` defaulting to David.
- Existing positional connection fixtures and injected Plaid adapter factories updated to the explicit profile/environment contract.
- Full backend tests, frontend unit tests, type checking, production build, Playwright, dependency audits, SQLite integrity check, backup restore drill, and sensitive-data scans before push.

Credentialed smoke testing is local-only. It first configures and connects an Ariela Sandbox team. A Production connection is attempted only after the Plaid Dashboard confirms Ariela's eligibility and the Sandbox run proves profile-correct connection, sync, repair, and revocation behavior. The smoke test must not reconnect or recreate any existing David Production Item.

## Documentation

Update the README and security/setup documentation with:

- Both profile-specific configuration commands.
- The rule that each Plaid Item remains bound to its creating profile.
- How to identify a connection's profile in the UI.
- The warning that a second developer team does not guarantee another Trial allowance.
- The fact that Roth IRAs still require the separate Plaid Investments implementation.
