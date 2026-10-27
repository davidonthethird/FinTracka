# Multi-Plaid Credential Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one FinTracka ledger safely connect Plaid Items owned by either David's or Ariela's separately configured Plaid developer credentials.

**Architecture:** Add a fixed `david | ariela` credential-profile field to Plaid connections and profile-scoped Keychain-reference metadata. New Link sessions use the profile selected by the user; sync, repair, and revoke always derive both profile and environment from the stored connection. The canonical ledger, account ownership, reports, and UI session model remain shared and unchanged.

**Tech Stack:** Python 3.14, SQLite numbered migrations, macOS Keychain via `keyring`, FastAPI/Pydantic, React/TypeScript/Vite, Pytest, Playwright.

**Spec:** [Multi-Plaid Credential Profiles Design](../specs/2026-10-26-multi-plaid-profiles-design.md)

## Global Constraints

- Keep the profiles fixed to `david` and `ariela`; do not build arbitrary profile management.
- Existing Plaid configuration and every existing Plaid connection migrate to `david` without relinking.
- Never put Plaid client IDs, secrets, access tokens, public tokens, OAuth payloads, or raw provider responses in SQLite, logs, browser storage, API responses, Git, or CI.
- A connection never falls back to another profile or environment when credentials are absent.
- Profile routing is independent of `spending_owner`; household reporting stays combined.
- Roth IRA and Plaid Investments support remain out of scope.
- Preserve the existing strict Host, Origin, session-cookie, CSRF, CSP, optimistic-write, cursor atomicity, and sanitized-error behavior.
- Preserve the user's existing unstaged edit in `tests/test_readiness.py`; integrate around it without replacing it.

## Review Focus

1. A stored connection must use its stored profile and environment even after that profile's selected environment changes.
2. If one profile is missing credentials or one connection fails, other active connections still sync and commit, checkpoints on failures do not advance, and the overall job ends failed with a sanitized aggregate error.
3. If SQLite persistence fails after new Keychain writes, the prior working configuration remains active and only the new entries are removed.
4. Migration 013 must copy all legacy Sandbox and Production reference metadata to David, preserve every financial row/cursor/ID, and refuse to mutate a file-backed database when its pre-migration backup cannot be verified.
5. Invalid or spoofed profiles, unexpected request fields, and attempts to select a profile during repair/revoke must be rejected or ignored by contract; no response or log may expose secret values or Keychain references.

---

## Task 1: Add the profile column and a verified pre-migration backup gate

**Files:**

- Create: `src/fintracka/migrations/013_plaid_credential_profiles.sql`
- Modify: `src/fintracka/db.py`
- Modify: `src/fintracka/backups.py`
- Modify: `tests/test_foundation.py`
- Modify: `tests/test_operations.py`

**Interfaces:**

- `provider_connections.credential_profile TEXT NOT NULL DEFAULT 'david' CHECK(credential_profile IN ('david', 'ariela'))`
- `backup_connection(connection: sqlite3.Connection, backup_directory: Path, *, filename: str) -> Path`
- `migrate(connection: sqlite3.Connection) -> None` keeps its public signature; for a file-backed database with pending migration 013 it derives `<database parent>/backups`, creates a verified `0600` backup, then applies 013.
- Migration 013 copies reference strings only:
  - `plaid.environment` -> `plaid.profile.david.environment`
  - `plaid.sandbox.client_id_ref` and `plaid.sandbox.secret_ref` -> profile-scoped Sandbox keys
  - `plaid.production.client_id_ref` and `plaid.production.secret_ref` -> profile-scoped Production keys

- [ ] Add a failing foundation migration test that builds a version-12 database containing a Plaid connection, cursor, account, transaction, both legacy environment reference pairs, and a selected production environment. Run:

  ```bash
  .venv/bin/pytest tests/test_foundation.py -k plaid_profile_migration -q
  ```

  Assert migration 013 assigns `david`, copies all five metadata values, leaves old metadata intact, and preserves the exact connection, cursor, account, transaction IDs, row counts, and transaction sum.

- [ ] Add a failing operations test proving migration 013 creates one integrity-valid `0600` backup before mutation, and monkeypatch backup verification to fail so the database remains at version 12 with no `credential_profile` column. Run:

  ```bash
  .venv/bin/pytest tests/test_operations.py -k pre_migration -q
  ```

- [ ] Implement `backup_connection` by reusing the existing temporary-file, SQLite online-backup, integrity-check, atomic-replace, chmod, and fsync sequence. Do not add a dependency or custom backup format.

- [ ] Update `migrate` to inspect `PRAGMA database_list`; skip the backup only for `:memory:`/temporary databases, require the verified backup for file-backed databases immediately before 013, and apply the SQL only after backup success.

- [ ] Add migration 013 with the constrained column and `INSERT OR IGNORE ... SELECT ...` metadata copies. Update existing migration-version assertions from `range(1, 13)` to `range(1, 14)`.

- [ ] Run the focused tests and then the migration callers most likely to expose signature or fixture regressions:

  ```bash
  .venv/bin/pytest tests/test_foundation.py tests/test_operations.py tests/test_sync.py -q
  ```

- [ ] Commit:

  ```bash
  git add src/fintracka/migrations/013_plaid_credential_profiles.sql src/fintracka/db.py src/fintracka/backups.py tests/test_foundation.py tests/test_operations.py
  git commit -m "feat: migrate Plaid credential profiles safely"
  ```

## Task 2: Make Plaid configuration profile-scoped and rollback-safe

**Files:**

- Modify: `src/fintracka/plaid_service.py`
- Modify: `tests/test_plaid_service.py`

**Interfaces:**

- `PlaidProfile = Literal["david", "ariela"]`
- `PLAID_PROFILES: tuple[PlaidProfile, ...] = ("david", "ariela")`
- `PlaidConfiguration(profile, environment, client_id, secret)`
- `configure_plaid(connection, secrets, profile, environment, client_id, secret) -> None`
- `load_plaid_configuration(connection, secrets, profile, environment=None) -> PlaidConfiguration`
- `build_plaid_adapter(connection, secrets, profile, environment=None, client_factory=OfficialPlaidClient) -> PlaidAdapter`
- New Keychain references: `plaid:profile:<profile>:<environment>:<kind>:<configuration_uuid>`
- Configuration audit target: `entity_id = "plaid:<profile>"`

- [ ] Replace the current configuration test with failing tests for independent David/Ariela settings, Sandbox/Production separation, explicit-environment loading, default selected-environment loading, invalid profiles, and absence of all fake credential values from `connection.iterdump()`.

- [ ] Add a failing rollback test: establish a working David configuration, force the metadata transaction to fail after two new Keychain writes, then assert the old configuration still loads and both newly created Keychain entries were deleted.

- [ ] Run and confirm the focused failure:

  ```bash
  .venv/bin/pytest tests/test_plaid_service.py -k "configuration or rollback" -q
  ```

- [ ] Implement profile validation and profile-scoped metadata lookup. Generate one configuration UUID per configure call, write the two new Keychain values, atomically repoint metadata, delete only newly written values on failure, and best-effort delete superseded references after commit.

- [ ] Keep legacy reference strings usable after migration; loading follows whatever reference string SQLite stores and never rewrites a secret.

- [ ] Update adapter construction to require a profile and optionally an explicit environment. Do not provide an implicit David fallback inside the service API.

- [ ] Run:

  ```bash
  .venv/bin/pytest tests/test_plaid_service.py -k "configuration or adapter" -q
  ```

- [ ] Commit:

  ```bash
  git add src/fintracka/plaid_service.py tests/test_plaid_service.py
  git commit -m "feat: isolate Plaid credentials by profile"
  ```

## Task 3: Route each connection lifecycle through its stored profile

**Files:**

- Modify: `src/fintracka/plaid_service.py`
- Modify: `tests/test_plaid_service.py`
- Modify: `tests/test_sync.py`

**Interfaces:**

- `PlaidAdapterFactory = Callable[[PlaidProfile, PlaidEnvironment], PlaidAdapter]`
- `complete_plaid_connection(connection, adapter, public_token, profile) -> dict[str, str]`
- `repair_plaid_connection(connection, adapter_factory, connection_id) -> LinkSession`
- `revoke_plaid_connection(connection, adapter_factory, connection_id) -> None`
- `sync_plaid_connections(connection, adapter_factory) -> list[str]`
- `_connection_secret(...)` returns stored `credential_profile`, `environment`, status, and access-token reference.
- `PlaidSyncFailed(RuntimeError)` exposes only a sanitized failure count/message.

- [ ] Add failing completion tests proving David and Ariela connections persist the requested profile, return only sanitized fields, and revoke the partially created Item with the same adapter when database persistence fails.

- [ ] Add failing repair/revoke tests where selected profile environments differ from connection environments. Assert the factory receives only the target row's stored `(profile, environment)` and a request cannot substitute another profile.

- [ ] Add a failing mixed-sync test with at least three active connections: David Production succeeds, Ariela Sandbox raises `ProviderActionRequired`, Ariela Production succeeds. Assert both successes commit, only the failed Item becomes `repair`, its checkpoint is unchanged, every connection is attempted, and one sanitized `PlaidSyncFailed` is raised after the loop.

- [ ] Add a failing missing-credentials test proving no attempt is made with another profile/environment and the error text contains neither fake credential nor access-token values.

- [ ] Run the failing slice:

  ```bash
  .venv/bin/pytest tests/test_plaid_service.py tests/test_sync.py -k "profile or mixed or revoke or repair" -q
  ```

- [ ] Add `credential_profile` to connection insert/select statements. Cache adapters by `(profile, environment)` during one sync run, but do not introduce a general provider registry.

- [ ] Change sync to catch per-connection failures, persist only a sanitized connection status/error code, continue the loop, and raise the aggregate after all attempts. Retain `apply_batch` as the only ledger/checkpoint commit path.

- [ ] Run:

  ```bash
  .venv/bin/pytest tests/test_plaid_service.py tests/test_sync.py -q
  ```

- [ ] Commit:

  ```bash
  git add src/fintracka/plaid_service.py tests/test_plaid_service.py tests/test_sync.py
  git commit -m "feat: route Plaid items by stored profile"
  ```

## Task 4: Expose strict profile-aware API contracts, readiness, and CSP

**Files:**

- Modify: `src/fintracka/api.py`
- Modify: `src/fintracka/readiness.py`
- Modify: `tests/test_api.py`
- Modify carefully: `tests/test_readiness.py`

**Interfaces:**

- `PlaidSessionRequest(profile: Literal["david", "ariela"])`
- `PlaidCompleteRequest(public_token, profile)`
- Injected adapter factory: `Callable[[sqlite3.Connection, PlaidProfile, PlaidEnvironment | None], PlaidAdapter]`
- `GET /api/v1/providers` Plaid shape:

  ```json
  {
    "id": "plaid",
    "name": "Plaid",
    "enabled": true,
    "profiles": [
      {"id": "david", "label": "David", "configured": true, "environment": "production"},
      {"id": "ariela", "label": "Ariela", "configured": false}
    ]
  }
  ```

- `GET /api/v1/connections` adds `credential_profile`.
- `_secured(response, nonce, plaid_environments)` allows only the union of configured `https://sandbox.plaid.com/` and `https://production.plaid.com/` endpoints.
- Readiness IDs: `plaid_david` and `plaid_ariela`.

- [ ] Update the API test doubles to accept `(connection, profile, environment)` and add failing endpoint tests for both profile session/complete paths, sanitized provider/connection responses, invalid profile values, unexpected fields, missing CSRF, hostile Origin/Host, and repair/disconnect deriving rather than accepting a profile.

- [ ] Add a failing CSP test with David Production and Ariela Sandbox configured. Assert both exact Plaid API origins are present, no wildcard is present, and the existing CDN/frame restrictions remain.

- [ ] Add a failing startup/manual sync API test proving a persisted job uses both profiles and becomes failed only after other connections have been attempted.

- [ ] Extend the existing readiness tests without discarding the user's unstaged Python-version fixture change. Assert an unused unconfigured profile is a warning, while missing credentials for a profile with an active connection are blocking; the other profile remains independently usable.

- [ ] Run the failing slice:

  ```bash
  .venv/bin/pytest tests/test_api.py tests/test_readiness.py -k "plaid or startup or readiness" -q
  ```

- [ ] Implement strict request models and the profile status response. New Link uses the request profile; completion rebuilds that same profile's adapter; repair, revoke, manual sync, and startup sync pass the profile-aware factory into the service.

- [ ] Replace the single startup environment lookup with a set built from configured profile metadata. Do not use `connect-src *` or accept browser-provided origins.

- [ ] Update readiness to resolve each profile independently and query whether that profile has active connections before choosing warning versus blocking failure.

- [ ] Run:

  ```bash
  .venv/bin/pytest tests/test_api.py tests/test_readiness.py -q
  ```

- [ ] Commit only the new profile-related hunks from `tests/test_readiness.py`; leave its pre-existing Python-version fixture hunk unstaged and intact:

  ```bash
  git add src/fintracka/api.py src/fintracka/readiness.py tests/test_api.py
  git add -p tests/test_readiness.py
  git commit -m "feat: add profile-aware Plaid API and readiness"
  ```

## Task 5: Add the CLI profile selector with David compatibility

**Files:**

- Modify: `src/fintracka/cli.py`
- Modify: `tests/test_cli.py`
- Modify: `README.md`

**Interfaces:**

- `fintracka configure plaid --profile david|ariela --environment sandbox|production --client-id ... --secret-stdin`
- `--profile` defaults to `david`.
- `fintracka sync` continues syncing all active connections; it does not accept a profile filter.

- [ ] Add failing CLI tests proving explicit `--profile ariela` configures only Ariela, omitting `--profile` configures David, output names profile/environment without echoing any credential, and `sync` routes two stored profiles through the adapter factory.

- [ ] Run:

  ```bash
  .venv/bin/pytest tests/test_cli.py -k plaid -q
  ```

- [ ] Add one parser argument and pass it to `configure_plaid`. Replace the CLI's one pre-built sync adapter with the smallest factory that calls `build_plaid_adapter(connection, secrets, profile, environment)`.

- [ ] Update README commands for David and Ariela, explain permanent Item/profile binding and shared-ledger ownership, warn that a second Plaid team does not guarantee a second Trial allowance, and state that Roth IRAs still need a separate Investments implementation.

- [ ] Run:

  ```bash
  .venv/bin/pytest tests/test_cli.py -q
  ```

- [ ] Commit:

  ```bash
  git add src/fintracka/cli.py tests/test_cli.py README.md
  git commit -m "feat: configure named Plaid profiles from CLI"
  ```

## Task 6: Show both profiles on Connections and verify the complete slice

**Files:**

- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/e2e/fintracka.spec.ts`
- Modify: `BANK_INTEGRATION_PLAN.md`
- Modify: `SECURITY_PLAN.md`

**Interfaces:**

- `PlaidProfileStatus = { id: "david" | "ariela"; label: string; configured: boolean; environment?: string }`
- `Provider.profiles?: PlaidProfileStatus[]`
- `Connection.credential_profile?: "david" | "ariela"`
- Link state includes the selected profile for connect mode; browser state contains no credentials and is discarded when Link closes.

- [ ] Update the Playwright mocks first and add a failing UI path that shows two Plaid rows, disables unconfigured Ariela, launches David with `{"profile":"david"}`, then configures both mocks, launches Ariela, completes with the same profile, and displays profile labels in the connection list/detail.

- [ ] Add assertions that repair/disconnect bodies cannot select a profile, Sync now still covers all connections, and combined Accounts/Transactions remain one household view.

- [ ] Run the failing browser case:

  ```bash
  cd frontend && npx playwright test -g "Plaid profiles"
  ```

- [ ] Replace the single Plaid provider row with two compact profile rows using the existing provider-list styles. Keep one shared Sync now action and the existing repair/disconnect controls. Add only the CSS needed for readable profile rows at the current responsive breakpoints.

- [ ] Update integration/security docs with profile-scoped Keychain references, stored routing, failure isolation, CSP union, readiness behavior, Trial caveat, and Investments non-goal.

- [ ] Run frontend verification:

  ```bash
  cd frontend
  npm test
  npm run typecheck
  npm run build
  npx playwright test
  ```

- [ ] Run backend and repository verification from the worktree root:

  ```bash
  .venv/bin/pytest -q
  .venv/bin/pip-audit
  cd frontend && npm audit --audit-level=high
  cd .. && scripts/verify.sh
  ```

- [ ] Run the local-data safety checks without printing credential values:

  ```bash
  .venv/bin/python scripts/scan_local_secrets.py
  sqlite3 "$HOME/Library/Application Support/FinTracka/fintracka.sqlite3" "PRAGMA integrity_check;"
  ```

- [ ] Inspect the full diff for profile/environment fallback, secret exposure, and accidental staging of unrelated files:

  ```bash
  git diff --check
  git status --short
  git diff --stat
  ```

- [ ] Commit:

  ```bash
  git add frontend/src/App.tsx frontend/src/styles.css frontend/e2e/fintracka.spec.ts BANK_INTEGRATION_PLAN.md SECURITY_PLAN.md
  git commit -m "feat: expose David and Ariela Plaid profiles"
  ```

## Task 7: Local-only smoke test and merge gate

**Files:**

- No tracked credential files.
- Append results only to an existing ignored/local test note if one exists; otherwise report them in the implementation handoff.

- [ ] Confirm `git status`, Git history, SQLite, logs, frontend assets, browser storage, screenshots, and API responses contain no credential or financial payload beyond the user's local ledger.

- [ ] Configure Ariela Sandbox with `--profile ariela`, connect a Sandbox Item, sync twice, and verify unchanged transaction counts/totals on the second sync.

- [ ] Verify Ariela Sandbox repair and revoke route through Ariela while an existing David Production Item remains untouched. Do not recreate or reconnect David's Production Item.

- [ ] Restore the verified pre-migration backup into an empty temporary data directory and compare schema integrity, audited row counts, connection IDs, checkpoints, and report totals.

- [ ] Request a fresh code review focused on the five Review Focus cases, fix material findings, and rerun the smallest affected suites.

- [ ] Only after the Plaid Dashboard confirms Ariela's Production/Trial eligibility, configure Ariela Production and connect one institution. Reconcile it before adding Fidelity or Pershing; provider coverage and Investments support are separate acceptance questions.

- [ ] Push the reviewed branch and open/update the PR only after every required check is green.

## Self-Review Checklist

- [ ] Every goal, constraint, API change, migration guarantee, UI state, readiness rule, and documentation item in the approved spec maps to a task above.
- [ ] Every new branch involving profile selection, migration/backup, credentials, per-connection failure, or CSP has a focused automated test before implementation.
- [ ] All changed service callers, API test factories, CLI tests, migration fixtures, readiness fixtures, and Playwright mocks use the explicit profile/environment contract.
- [ ] No task adds arbitrary profile management, Investments, a second ledger, or spending-owner inference.
- [ ] Commits are reviewable and do not include the user's unrelated work unless explicitly integrated.
