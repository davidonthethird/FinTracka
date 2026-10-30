# FinTracka Remote Viewer Product Phases 1–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a secure, mobile-first, read-only FinTracka viewer and automatically keep its sanitized snapshot current while the Mac is available, without exposing or duplicating the authoritative local ledger.

**Architecture:** Python builds one deterministic `RemoteSnapshotV1` directly from existing local read models. The same local publisher is used by manual, startup, post-sync, and hourly triggers; it uploads an immutable JSON object to a service-authenticated Publisher Worker, which validates it and atomically switches a strongly consistent R2 active manifest. A separate Access-protected Viewer Worker serves a read-only React build and the active snapshot.

**Tech Stack:** Python 3.14, SQLite, FastAPI, macOS Keychain/launchd, TypeScript 7, React 19, Vite 8, Vitest, Playwright, Cloudflare Workers, R2, Access Service Auth.

**Spec:** `docs/superpowers/specs/2026-10-27-remote-viewer-phase-1-2-design.md`

## Global Constraints

- SQLite on the Mac remains authoritative; remote data is disposable and read-only.
- Reuse `overview`, `planning_snapshot`, `savings_summary`, `savings_goal_overview`, `cash_flow`, `cash_flow_paths`, `spending_by_category`, and `spending_by_owner`; do not reimplement financial calculations in cloud code or React.
- All money stays integer minor units with an explicit ISO currency; no float arithmetic crosses the snapshot boundary.
- Publish six months of sanitized transaction detail and up to twelve months of locally precomputed aggregates needed by Planning, Savings, and Reports.
- Reject a snapshot larger than 5 MiB uncompressed. Crossing the limit requires a measured D1 redesign, not silent truncation.
- Publisher credentials live only in macOS Keychain; SQLite stores references and metadata only.
- GitHub Actions and repository fixtures contain synthetic data only and receive no Cloudflare, Plaid, Google, or household financial secrets.
- Cloudflare Access protects production and preview routes. Viewer policy is an exact human allowlist with MFA; Publisher policy is strict Service Auth.
- Viewer financial responses use `Cache-Control: no-store`; the viewer uses no service worker, IndexedDB, localStorage, or other persistent financial cache.
- Publication failures never roll back a successful bank sync, mutate ledger facts, or replace the last valid remote snapshot.
- Live household publication remains disabled until the staging gate and explicit privacy approval in Task 12.

## Review Focus

- **Bank sync succeeds but publication fails:** imported ledger data remains committed, remote active snapshot remains unchanged, and metadata records a publication failure without financial payloads. Covered by Task 9 tests.
- **Startup, sync, hourly, and manual triggers overlap:** exactly one local publisher runs; later callers exit safely or observe the same idempotent result. Covered by Task 3 and Task 9 tests.
- **An older SQLite backup is restored:** Publisher Worker rejects the lower sequence until an explicit purge/reset; it never silently rolls the viewer backward. Covered by Task 4 tests.
- **Mac is offline or Keychain is locked:** local app and bank sync continue to work, the last remote snapshot remains readable, and the next trigger can retry. Covered by Task 3, Task 9, and Task 10 tests.
- **Snapshot is oversized, malformed, or contains forbidden fields:** local preview/publish and Worker validation fail closed before activation. Covered by Task 2 and Task 4 tests.

---

## Product Phase 1 — Hosted Read-only Viewer

### Task 1: Persist Remote Configuration and Metadata-only Run State

**Files:**
- Create: `src/fintracka/migrations/018_remote_publication.sql`
- Create: `src/fintracka/remote_config.py`
- Test: `tests/test_remote_config.py`
- Modify: `src/fintracka/db.py` (include migration 18 in pre-migration backup set)

**Interfaces:**
- Produces: `RemoteSettings`, `RemoteRun`, `configure_remote()`, `load_remote_settings()`, `reserve_remote_sequence()`, `start_remote_run()`, and `finish_remote_run()`.
- Consumes: `KeychainSecrets` from `src/fintracka/keychain.py` and `new_id()` from `src/fintracka/ids.py`.

- [ ] **Step 1: Write failing migration/configuration tests**

  Cover default disabled state, allowed history range `1..6`, default interval `60`, monotonically increasing sequence, sanitized error codes, and Keychain/database rollback. Assert the SQLite file never contains the supplied Access Client Secret.

- [ ] **Step 2: Run the focused tests and verify failure**

  Run: `python -m pytest tests/test_remote_config.py -v`  
  Expected: FAIL because migration 18 and `fintracka.remote_config` do not exist.

- [ ] **Step 3: Add migration 18**

  Create singleton `remote_settings` and append-only `remote_publication_runs`. Store URLs, enablement, `history_months`, `interval_minutes`, Keychain reference names, next sequence, last snapshot/timestamps, status, reason, counts, duration, and a bounded error code. Do not store request bodies, merchant data, exception strings, or credentials.

- [ ] **Step 4: Implement the configuration API**

  Use these signatures:

  ```python
  @dataclass(frozen=True)
  class RemoteSettings: ...

  def configure_remote(
      connection: sqlite3.Connection,
      secrets: KeychainSecrets,
      *,
      viewer_url: str,
      publisher_url: str,
      access_client_id: str,
      access_client_secret: str,
      history_months: int = 6,
      interval_minutes: int = 60,
  ) -> RemoteSettings: ...

  def load_remote_settings(connection: sqlite3.Connection) -> RemoteSettings: ...
  def reserve_remote_sequence(connection: sqlite3.Connection) -> int: ...
  def start_remote_run(connection: sqlite3.Connection, reason: str, sequence: int) -> str: ...
  def finish_remote_run(connection: sqlite3.Connection, run_id: str, *, status: str, snapshot_id: str | None = None, error_code: str | None = None) -> None: ...
  ```

  Validate HTTPS URLs, reject fragments/userinfo, use fixed Keychain reference names, delete newly written secrets if SQLite persistence fails, and preserve previous credentials until the replacement configuration is durable.

- [ ] **Step 5: Run tests and commit**

  Run: `python -m pytest tests/test_remote_config.py tests/test_foundation.py -v`  
  Expected: PASS.

  ```bash
  git add src/fintracka/migrations/018_remote_publication.sql src/fintracka/remote_config.py src/fintracka/db.py tests/test_remote_config.py
  git commit -m "feat: persist remote publication settings"
  ```

### Task 2: Build the Canonical Sanitized Snapshot

**Files:**
- Create: `src/fintracka/remote_models.py`
- Create: `src/fintracka/remote_snapshot.py`
- Create: `tests/fixtures/remote_snapshot_v1.json`
- Create: `tests/test_remote_snapshot.py`
- Modify: `e2e/server.py` (export reusable deterministic synthetic seed helper if required)

**Interfaces:**
- Consumes: existing financial read-model functions named in Global Constraints.
- Produces: `RemoteSnapshotV1`, `build_remote_snapshot()`, `serialize_remote_snapshot()`, and `snapshot_digest()`.

- [ ] **Step 1: Write failing contract and privacy tests**

  Add tests named:

  - `test_snapshot_reuses_local_read_models_in_exact_minor_units`
  - `test_snapshot_contains_six_transaction_months_and_twelve_month_aggregates`
  - `test_snapshot_is_deterministic_for_fixed_clock_and_sequence`
  - `test_snapshot_excludes_secrets_provider_ids_notes_archived_and_raw_payloads`
  - `test_snapshot_rejects_more_than_five_mebibytes`
  - `test_snapshot_read_transaction_does_not_mutate_financial_tables`

  Seed unique canary values in every forbidden field and assert none appears in serialized bytes.

- [ ] **Step 2: Run tests and verify failure**

  Run: `python -m pytest tests/test_remote_snapshot.py -v`  
  Expected: FAIL because the models and builder do not exist.

- [ ] **Step 3: Define the versioned Pydantic contract**

  Use these entry points:

  ```python
  class RemoteSnapshotV1(BaseModel):
      model_config = ConfigDict(extra="forbid", frozen=True)
      schema_version: Literal[1]
      snapshot_id: str
      source_sequence: int
      captured_at: str
      source_last_sync_at: str | None
      sources: tuple[RemoteSourceFreshness, ...]
      history_start: str
      history_end: str
      overview: dict[str, RemoteOverview]
      transactions: tuple[RemoteTransaction, ...]
      planning: dict[str, RemotePlanningSnapshot]
      savings: dict[str, RemoteSavingsSnapshot]
      reports: dict[str, RemoteReportSnapshot]
      counts: RemoteCounts

  def build_remote_snapshot(
      connection: sqlite3.Connection,
      *,
      source_sequence: int,
      history_months: int,
      now: datetime,
      snapshot_id: str | None = None,
  ) -> RemoteSnapshotV1: ...

  def serialize_remote_snapshot(snapshot: RemoteSnapshotV1) -> bytes: ...
  def snapshot_digest(payload: bytes) -> str: ...
  ```

  Keys for multi-dimensional read models must be generated by one documented helper using month, window, and owner values; callers must not construct ad-hoc keys.

- [ ] **Step 4: Implement one consistent read builder**

  Start an explicit SQLite read transaction and always roll it back after extraction. Reuse local read-model functions. Add only the sanitized transaction query needed by the remote contract. Sort every collection deterministically before serialization and enforce UTF-8/5 MiB limits after serialization.

- [ ] **Step 5: Freeze the shared synthetic fixture**

  Generate `tests/fixtures/remote_snapshot_v1.json` from a fixed time, sequence, and synthetic database. Review the file for canaries and real data before adding it to Git.

- [ ] **Step 6: Run tests and commit**

  Run: `python -m pytest tests/test_remote_snapshot.py tests/test_planning.py tests/test_savings.py tests/test_budgets_reports.py -v`  
  Expected: PASS.

  ```bash
  git add src/fintracka/remote_models.py src/fintracka/remote_snapshot.py tests/test_remote_snapshot.py tests/fixtures/remote_snapshot_v1.json e2e/server.py
  git commit -m "feat: build sanitized remote snapshots"
  ```

### Task 3: Add the Single Manual Publication Service and CLI

**Files:**
- Create: `src/fintracka/remote_client.py`
- Create: `src/fintracka/remote_service.py`
- Create: `tests/test_remote_service.py`
- Modify: `src/fintracka/cli.py`
- Modify: `tests/test_cli.py`

**Interfaces:**
- Consumes: Task 1 settings/run state and Task 2 snapshot serialization.
- Produces: `RemotePublisherClient`, `PublishResult`, `publish_remote_snapshot()`, `purge_remote_snapshots()`, and CLI commands under `fintracka remote`.

- [ ] **Step 1: Write failing client/service tests**

  Cover successful publication, service-token headers, content digest, disabled configuration, idempotent response, timeout, HTTP 401/403/409/413/5xx mapping, locked Keychain, failure redaction, concurrent lock contention, and purge confirmation. Assert an HTTP failure never deletes or changes local financial rows.

- [ ] **Step 2: Run focused tests and verify failure**

  Run: `python -m pytest tests/test_remote_service.py tests/test_cli.py -v`  
  Expected: FAIL because the remote client/service and commands do not exist.

- [ ] **Step 3: Implement the standard-library HTTP client**

  ```python
  @dataclass(frozen=True)
  class PublishResult:
      snapshot_id: str
      source_sequence: int
      published_at: str
      idempotent: bool

  class RemotePublisherClient:
      def publish(self, payload: bytes, digest: str) -> PublishResult: ...
      def purge(self) -> None: ...

  def publish_remote_snapshot(
      database_path: Path,
      secrets: KeychainSecrets,
      *,
      reason: Literal["manual", "startup", "sync", "scheduled"],
      client_factory: Callable[[RemoteSettings, KeychainSecrets], RemotePublisherClient] = RemotePublisherClient.from_settings,
      now: Callable[[], datetime] = utc_instant,
  ) -> PublishResult | None: ...
  ```

  Use `urllib.request`, fixed connect/read timeout, two bounded retries for network/5xx only, and `ProcessLock(<data-dir>/fintracka-remote.lock)`. Never log response bodies or unsanitized exceptions.

- [ ] **Step 4: Add CLI configuration and manual operations**

  Add:

  - `fintracka configure remote --viewer-url … --publisher-url … --client-id … --secret-stdin`
  - `fintracka remote preview [--output …]`
  - `fintracka remote publish`
  - `fintracka remote status`
  - `fintracka remote purge --confirm-delete-remote-snapshot`

  `preview` reads the selected local database but never prints financial JSON to Terminal by default, only counts, dates, byte size, and digest. Tests and CI always select a synthetic data directory. An optional output file is mode `0600` and requires an explicit path.

- [ ] **Step 5: Run tests and commit**

  Run: `python -m pytest tests/test_remote_service.py tests/test_cli.py tests/test_operations.py -v`  
  Expected: PASS.

  ```bash
  git add src/fintracka/remote_client.py src/fintracka/remote_service.py src/fintracka/cli.py tests/test_remote_service.py tests/test_cli.py
  git commit -m "feat: publish remote snapshots manually"
  ```

### Task 4: Build the Service-authenticated Publisher Worker and R2 Activation

**Files:**
- Create: `remote/package.json`
- Create: `remote/package-lock.json`
- Create: `remote/tsconfig.json`
- Create: `remote/wrangler.publisher.jsonc`
- Create: `remote/src/contract.ts`
- Create: `remote/src/storage.ts`
- Create: `remote/src/publisher.ts`
- Create: `remote/tests/publisher.test.ts`
- Create: `remote/tests/contract-fixture.test.ts`

**Interfaces:**
- Consumes: Task 2 fixture and `POST /v1/snapshots` payload/headers from Task 3.
- Produces: Publisher endpoints `POST /v1/snapshots`, `DELETE /v1/snapshots`, and R2 keys `snapshots/<snapshot_id>.json` plus `active.json`.

- [ ] **Step 1: Scaffold the smallest Worker package**

  Pin Wrangler, TypeScript, Vitest, and Zod. Add scripts `test`, `typecheck`, `deploy:publisher:staging`, and `deploy:publisher:production`. Configure separate staging/production R2 bindings without account IDs or secrets in the repository.

- [ ] **Step 2: Write failing contract/storage tests**

  Read `../tests/fixtures/remote_snapshot_v1.json` and assert it validates. Add tests for extra fields, floats, unsupported schema, invalid dates/currency, forbidden keys, >5 MiB body, digest mismatch, first activation, idempotent replay, competing writers, lower sequence, activation failure, retention of active+previous, and purge.

- [ ] **Step 3: Run tests and verify failure**

  Run: `cd remote && npm test -- --run`  
  Expected: FAIL because Worker implementation is absent.

- [ ] **Step 4: Implement strict validation and immutable storage**

  Define:

  ```ts
  export const RemoteSnapshotV1Schema: z.ZodType<RemoteSnapshotV1>;
  export async function activateSnapshot(bucket: R2Bucket, payload: Uint8Array, digest: string): Promise<ActiveManifest>;
  export async function purgeSnapshots(bucket: R2Bucket): Promise<void>;
  ```

  Write the version object with create-once semantics, then conditionally update `active.json` against its prior ETag. Re-read after ambiguous writes. A loser in a race re-reads active state and returns idempotent success only for identical snapshot ID/digest; otherwise return `409`.

- [ ] **Step 5: Implement the Publisher Worker trust boundary**

  Reject every route/method except the two explicit endpoints. Require the deployment to be behind strict Access Service Auth; do not add an application HMAC or nonce table. Return only IDs, sequences, timestamps, and stable error codes. Apply no-store/security headers and no financial logging.

- [ ] **Step 6: Run tests, typecheck, and commit**

  Run: `cd remote && npm test -- --run && npm run typecheck`  
  Expected: PASS.

  ```bash
  git add remote
  git commit -m "feat: add atomic remote snapshot publisher"
  ```

### Task 5: Build the Access-protected Read-only Viewer Worker

**Files:**
- Create: `remote/wrangler.viewer.jsonc`
- Create: `remote/src/viewer.ts`
- Create: `remote/tests/viewer.test.ts`
- Modify: `remote/package.json`

**Interfaces:**
- Consumes: Task 4 `active.json` and immutable snapshot objects.
- Produces: same-origin `GET /api/v1/snapshot`, `GET /api/v1/status`, and static asset fallback through the Worker assets binding.

- [ ] **Step 1: Write failing viewer tests**

  Cover no snapshot, active snapshot, missing referenced object, stale metadata, `GET`/`HEAD` behavior, rejection of `POST`/`PUT`/`PATCH`/`DELETE`, path traversal, no-store/CSP/referrer/frame headers, and an R2 error that returns a redacted response.

- [ ] **Step 2: Run tests and verify failure**

  Run: `cd remote && npm test -- --run tests/viewer.test.ts`  
  Expected: FAIL because `viewer.ts` does not exist.

- [ ] **Step 3: Implement the Viewer Worker**

  Read `active.json`, fetch exactly its immutable key, verify stored digest metadata, and return the payload without transformation. `/api/v1/status` returns timestamps, history boundaries, schema version, sequence, and counts only. Static asset fallback serves the dedicated viewer build. Set `run_worker_first` for `/api/*` and protect the complete production and preview Worker with an exact Cloudflare Access policy.

- [ ] **Step 4: Run tests/typecheck and commit**

  Run: `cd remote && npm test -- --run && npm run typecheck`  
  Expected: PASS.

  ```bash
  git add remote/wrangler.viewer.jsonc remote/src/viewer.ts remote/tests/viewer.test.ts remote/package.json remote/package-lock.json
  git commit -m "feat: serve active snapshots read only"
  ```

### Task 6: Add the Mobile Viewer Shell, Overview, and Transactions

**Files:**
- Create: `frontend/viewer.html`
- Create: `frontend/vite.viewer.config.ts`
- Create: `frontend/src/viewer/main.tsx`
- Create: `frontend/src/viewer/ViewerApp.tsx`
- Create: `frontend/src/viewer/api.ts`
- Create: `frontend/src/viewer/model.ts`
- Create: `frontend/src/viewer/OverviewPage.tsx`
- Create: `frontend/src/viewer/TransactionsPage.tsx`
- Create: `frontend/src/viewer/TransactionDrawer.tsx`
- Create: `frontend/src/viewer/viewer.css`
- Create: `frontend/tests/viewer-model.test.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/public/favicon.svg` only if the existing FinTracka icon cannot be reused unchanged

**Interfaces:**
- Consumes: Task 5 `/api/v1/snapshot`; imports pure `formatMoney` and existing chart/model helpers where they have no mutation dependency.
- Produces: `npm run build:viewer` output in `frontend/dist-viewer`.

- [ ] **Step 1: Write failing model/filter tests**

  Test schema/version rejection, month sorting, transaction search, account/category/owner/month filters, bounded client pagination, freshness age labels, integer money formatting, and no writes to browser persistence APIs.

- [ ] **Step 2: Run tests and verify failure**

  Run: `cd frontend && npm test -- --run tests/viewer-model.test.ts`  
  Expected: FAIL because viewer models do not exist.

- [ ] **Step 3: Add the dedicated viewer build**

  Add `build:viewer`, `dev:viewer`, and `typecheck:viewer` scripts. The viewer bundle must not import local-session bootstrap, Plaid Link, CSRF mutation helpers, Connections, Rules, Settings mutations, or any local admin route.

- [ ] **Step 4: Implement the shell and freshness panel**

  Use a five-item mobile bottom navigation and accessible desktop layout. Load the snapshot once into React memory using `cache: "no-store"`; clear component state on auth/error navigation and never persist it. Show `captured_at`, `source_last_sync_at`, and remote publication time with distinct labels.

- [ ] **Step 5: Implement Overview and Transactions**

  Match local amounts and owner colors. Transactions provide search, account/category/owner/month filters, 50-row pages, and a drawer showing every allowed account/transaction detail. No archive, category, split, sync, or edit control may appear.

- [ ] **Step 6: Test, build, and commit**

  Run: `cd frontend && npm test -- --run && npm run typecheck && npm run build:viewer`  
  Expected: PASS; `dist-viewer` contains only the remote viewer entry/assets.

  ```bash
  git add frontend/viewer.html frontend/vite.viewer.config.ts frontend/src/viewer frontend/tests/viewer-model.test.ts frontend/package.json frontend/package-lock.json
  git commit -m "feat: add mobile remote overview and transactions"
  ```

### Task 7: Complete Planning, Savings, and Reports Read-only Screens

**Files:**
- Create: `frontend/src/viewer/PlanningPage.tsx`
- Create: `frontend/src/viewer/SavingsPage.tsx`
- Create: `frontend/src/viewer/ReportsPage.tsx`
- Create: `frontend/src/viewer/CategoryDrawer.tsx`
- Create: `frontend/src/viewer/SavingsGoalDrawer.tsx`
- Create: `frontend/tests/viewer-pages.test.tsx`
- Modify: `frontend/src/viewer/ViewerApp.tsx`
- Modify: `frontend/src/viewer/viewer.css`

**Interfaces:**
- Consumes: immutable Planning/Savings/Reports maps in `RemoteSnapshotV1` and existing pure display helpers.
- Produces: all five complete read-only viewer tabs.

- [ ] **Step 1: Write failing page tests from the shared fixture**

  Assert Planning targets/actuals/averages/remaining and owner selection; Savings combined default, optional split, monthly/overall goals and activity; Reports category totals, owner shares, readable mobile flow and drill-downs. Assert no interactive element has a mutation label or sends a non-GET request.

- [ ] **Step 2: Run tests and verify failure**

  Run: `cd frontend && npm test -- --run tests/viewer-pages.test.tsx`  
  Expected: FAIL because the pages do not exist.

- [ ] **Step 3: Implement Planning and Savings**

  Render only precomputed local results. Reuse the current status colors, FinTracka favicon/icon set, and pure planning/savings display helpers. Drawers show transaction/goal detail but omit category, target, allocation, initialization, review, withdrawal-assignment, and asset-edit controls.

- [ ] **Step 4: Implement Reports for mobile and desktop**

  Use category bars and owner shares on narrow screens. Use the existing flow helper on wide screens only when labels remain readable. Every chart includes text values/legend and accessible descriptions; color is never the sole indicator.

- [ ] **Step 5: Test, build, and commit**

  Run: `cd frontend && npm test -- --run && npm run typecheck && npm run build:viewer`  
  Expected: PASS.

  ```bash
  git add frontend/src/viewer frontend/tests/viewer-pages.test.tsx
  git commit -m "feat: complete read-only remote finance screens"
  ```

## Product Phase 2 — Automatic Snapshot Synchronization

### Task 8: Add Local Settings, Manual Publish, Status, and Purge Controls

**Files:**
- Modify: `src/fintracka/api.py`
- Modify: `tests/test_api.py`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/api.ts` only if a reusable polling helper is needed
- Modify: `frontend/src/styles.css`
- Modify: `frontend/e2e/fintracka.spec.ts`

**Interfaces:**
- Consumes: Task 3 service and existing `JobRunner`.
- Produces: local-only settings endpoints and UI; no remote administrative controls are exposed through the hosted viewer.

- [ ] **Step 1: Write failing API security/status tests**

  Add tests for:

  - `GET /api/v1/settings/remote`
  - `POST /api/v1/settings/remote/publish`
  - `DELETE /api/v1/settings/remote/snapshot`

  Preserve session cookie, CSRF, Host/Origin, empty-body, unexpected-field, and redaction rules. Purge requires exact confirmation text in the request body. API responses never return URLs containing credentials or Keychain values.

- [ ] **Step 2: Implement API endpoints using the persisted job runner**

  Manual publish uses `jobs.submit("remote_publish", ...)`; purge uses `jobs.submit("remote_purge", ...)`. Status returns enablement, schedule status, dates, counts, last stable error code, and viewer URL only.

- [ ] **Step 3: Add local Settings controls**

  Show Remote viewer status, privacy warning, Open viewer, Publish now, last source/bank/cloud timestamps, schedule state, and destructive Delete remote copy. Do not accept publisher secrets in the browser; configuration remains CLI/Keychain-only.

- [ ] **Step 4: Add Playwright coverage and commit**

  Run: `python -m pytest tests/test_api.py -v && cd frontend && npm run test:e2e -- --grep "remote viewer settings"`  
  Expected: PASS.

  ```bash
  git add src/fintracka/api.py tests/test_api.py frontend/src/App.tsx frontend/src/api.ts frontend/src/styles.css frontend/e2e/fintracka.spec.ts
  git commit -m "feat: manage remote publication locally"
  ```

### Task 9: Connect Startup and Successful Bank Sync to the Shared Publisher

**Files:**
- Modify: `src/fintracka/api.py` (`lifespan` and `/api/v1/sync-runs` work functions)
- Modify: `src/fintracka/cli.py` (`sync` command)
- Modify: `tests/test_api.py`
- Modify: `tests/test_cli.py`
- Modify: `tests/test_plaid_service.py` only if shared fake adapters need an assertion hook

**Interfaces:**
- Consumes: `publish_remote_snapshot()` from Task 3.
- Produces: startup and post-sync triggers; no new publication implementation.

- [ ] **Step 1: Write failing trigger-order tests**

  Assert:

  - startup sync completes before startup publication;
  - startup without a due bank sync still publishes once when enabled;
  - API and CLI sync publish only after all connection syncs succeed;
  - repair/partial sync failure does not publish;
  - publication failure does not mark the bank sync failed or roll it back;
  - disabled remote settings produce no network call;
  - simultaneous startup/manual trigger yields one publisher and no duplicate sequence.

- [ ] **Step 2: Run focused tests and verify failure**

  Run: `python -m pytest tests/test_api.py tests/test_cli.py tests/test_plaid_service.py -k "startup or sync or remote" -v`  
  Expected: FAIL on missing trigger calls/order.

- [ ] **Step 3: Wire existing callers to the shared service**

  In each existing work function, call `publish_remote_snapshot(..., reason="sync")` only after `sync_plaid_connections()` returns successfully. At app startup, keep operations on the single-thread `JobRunner`: submit one combined sync-then-publish job when sync is due, otherwise submit a startup publication job. Catch and record remote publication errors outside the bank-sync transaction/result.

- [ ] **Step 4: Run tests and commit**

  Run: `python -m pytest tests/test_api.py tests/test_cli.py tests/test_plaid_service.py tests/test_remote_service.py -v`  
  Expected: PASS.

  ```bash
  git add src/fintracka/api.py src/fintracka/cli.py tests/test_api.py tests/test_cli.py tests/test_plaid_service.py
  git commit -m "feat: publish after startup and bank sync"
  ```

### Task 10: Add the Opt-in Hourly macOS Publisher Schedule

**Files:**
- Modify: `src/fintracka/launchd.py`
- Modify: `src/fintracka/cli.py`
- Modify: `tests/test_operations.py`
- Modify: `tests/test_cli.py`
- Modify: `src/fintracka/api.py`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: Task 3 `fintracka remote publish` command.
- Produces: separate `com.fintracka.remote-publish` user LaunchAgent running every configured interval without changing the existing daily Plaid sync agent.

- [ ] **Step 1: Write failing plist/install tests**

  Assert label, absolute Python/data paths, `RunAtLoad`, `StartInterval=3600`, background process type, private log directory, no secrets in arguments/plist/log paths, atomic install, idempotent reinstall, status, and removal. Simulate `launchctl` failure and preserve the prior valid plist.

- [ ] **Step 2: Implement the separate remote LaunchAgent**

  Add `build_remote_launch_agent()`, `install_remote_schedule()`, `remote_schedule_status()`, and `remove_remote_schedule()` without changing `build_launch_agent()` behavior for bank sync.

- [ ] **Step 3: Expose CLI/API/Settings schedule controls**

  Add `fintracka remote schedule install|status|remove` and local Settings install/remove controls. The process exits successfully with a metadata-only skipped status when remote publication is disabled; locked Keychain/network errors are recorded and retried by the next scheduled run.

- [ ] **Step 4: Run tests and commit**

  Run: `python -m pytest tests/test_operations.py tests/test_cli.py tests/test_api.py -k "launch or schedule or remote" -v`  
  Expected: PASS.

  ```bash
  git add src/fintracka/launchd.py src/fintracka/cli.py src/fintracka/api.py frontend/src/App.tsx tests/test_operations.py tests/test_cli.py tests/test_api.py
  git commit -m "feat: schedule hourly remote snapshots"
  ```

### Task 11: Prove Contract Parity, Failure Recovery, Mobile Behavior, and Synthetic CI

**Files:**
- Create: `frontend/e2e/remote-viewer.spec.ts`
- Create: `frontend/e2e/remote-viewer-server.ts` or extend the existing synthetic server with an isolated viewer mode
- Create: `scripts/verify_remote_snapshot.py`
- Modify: `scripts/verify.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/dependabot.yml`
- Modify: `frontend/playwright.config.ts`
- Modify: `remote/package.json`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: one synthetic verification path that fails on Python/TypeScript contract drift, forbidden fields, security regression, mobile regression, or publication recovery regression.

- [ ] **Step 1: Add cross-runtime contract verification**

  `scripts/verify_remote_snapshot.py` rebuilds the fixed Python fixture and compares canonical bytes/digest. Remote Vitest validates the same fixture with Zod; frontend tests render it. No test may read the user's application data directory or Keychain.

- [ ] **Step 2: Add Worker fault-injection integration tests**

  Exercise connection loss before object write, after version write, and during manifest write; stale ETag; duplicate request; lower sequence; purge during read; missing object; and cleanup failure. Assert the old active snapshot remains readable except after an explicit successful purge.

- [ ] **Step 3: Add remote viewer Playwright tests**

  Cover widths 320/375/390/430 plus tablet/desktop, all five tabs, filters/drawers, owner splits, freshness, no-snapshot/stale/error states, long merchant names, negative/positive amounts, keyboard/zoom, and absence of mutation/admin controls. Assert no financial values enter localStorage, sessionStorage, IndexedDB, Cache Storage, console logs, or service-worker registrations.

- [ ] **Step 4: Extend CI and dependency auditing**

  Install `remote/package-lock.json` dependencies, run remote unit/type tests and both frontend builds, then the existing backend/frontend/e2e/audit suite. Add Dependabot for `/remote`. CI remains entirely synthetic and does not deploy Workers.

- [ ] **Step 5: Run the full local milestone and commit**

  Run:

  ```bash
  ./scripts/verify.sh
  python scripts/verify_remote_snapshot.py
  cd remote && npm test -- --run && npm run typecheck
  cd ../frontend && npm run build:viewer && npm run test:e2e -- remote-viewer.spec.ts
  ```

  Expected: every command exits 0; secret scan and audits find no high-severity issue or real-data canary.

  ```bash
  git add scripts/verify.sh scripts/verify_remote_snapshot.py .github/workflows/ci.yml .github/dependabot.yml frontend remote
  git commit -m "test: verify remote viewer end to end"
  ```

### Task 12: Stage, Exercise, and Gate the Workable Phase 2 End Product

**Files:**
- Create: `REMOTE_VIEWER_RUNBOOK.md`
- Create: `remote/README.md`
- Modify: `README.md`
- Modify: `RECOVERY_RUNBOOK.md`
- Modify: `SECURITY.md`
- Modify: `FinTracka-threat-model.md`

**Interfaces:**
- Consumes: tested artifacts from Tasks 1–11.
- Produces: reproducible staging deployment, revocation/purge/recovery procedures, measured size/performance evidence, and an explicit live-data release gate.

- [ ] **Step 1: Document exact staging provisioning**

  Include separate staging R2 bucket, Publisher Worker, Viewer Worker, Viewer Access application with exact David/Ariela identities and MFA, Publisher Access application with strict Service Auth, protected production and preview routes, Wrangler login/deploy commands, Keychain configuration, dashboard-based emergency revocation/purge when the Mac is unavailable, and no-secret verification commands. Do not record actual tokens or household emails in Git.

- [ ] **Step 2: Deploy synthetic staging only**

  Publish the canonical synthetic fixture manually. Verify wrong identity, missing/incorrect service token, unsupported methods, preview URLs, and direct R2 access are denied. Record snapshot byte size, publish duration, Worker CPU observations, and iPhone load/filter time.

- [ ] **Step 3: Exercise complete Product Phase 2 automation**

  On a staging Mac data directory, verify startup publication, successful-sync publication with mocked/sandbox provider data, hourly LaunchAgent publication, manual publication, concurrent triggers, offline retry, locked Keychain, Mac sleep/wake, Mac-off viewing, stale warning, service-token rotation, human-session revocation, and explicit purge.

- [ ] **Step 4: Apply the storage upgrade gate**

  If representative uncompressed snapshot size is `>5 MiB` or supported-iPhone filtering/loading is unacceptable, stop before live data and write a D1 migration design. Do not work around the limit by silently dropping fields, history, or records.

- [ ] **Step 5: Run the final security/privacy gate**

  Confirm no forbidden values in R2 metadata, Worker/Access logs, browser storage, build artifacts, error responses, local logs, or CI. Review current Plaid/cloud-processing terms, disclose that Cloudflare stores sanitized household transaction data, confirm purge limitations, and obtain explicit household approval.

- [ ] **Step 6: Perform the controlled live rollout only after approval**

  Configure production Workers/R2/Access with no data, rotate a production service token into Keychain, publish once manually, compare representative cents/totals across every tab, enable startup/post-sync/hourly triggers, turn the Mac off, and verify the viewer over iPhone cellular. Keep the prior local backup and documented purge/revocation path.

- [ ] **Step 7: Final verification and commit**

  Run: `./scripts/verify.sh`  
  Expected: PASS, followed by recorded staging acceptance results with no secrets or household financial values.

  ```bash
  git add REMOTE_VIEWER_RUNBOOK.md remote/README.md README.md RECOVERY_RUNBOOK.md SECURITY.md FinTracka-threat-model.md
  git commit -m "docs: add remote viewer operations runbook"
  ```

---

## Completion Definition

Product Phase 1 and Product Phase 2 ship together as the workable end product. Phase 1 is considered complete only when all five hosted screens run against the permanent snapshot contract and production-shaped manual publisher. Phase 2 is complete only when startup, successful bank sync, hourly launchd, and manual publication all reuse that publisher and pass interruption/recovery tests.

The remote viewer is never a backup, never a remote control surface, and never the authority for financial facts.
