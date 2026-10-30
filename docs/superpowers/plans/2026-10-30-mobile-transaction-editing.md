# Mobile Transaction Classification Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let either authorized household member submit a one-time transaction category/subcategory correction from the phone while the Mac is off, then have the Mac apply it exactly once within about one minute of waking.

**Architecture:** Extend the existing Access-protected Viewer Worker into a partitioned mobile gateway. D1 owns typed command/member state, R2 remains the immutable read snapshot, and a one-minute Mac LaunchAgent claims commands through a dedicated service identity, validates them against authoritative SQLite, records a permanent receipt, and republishes the snapshot.

**Tech Stack:** Python 3.14, SQLite, FastAPI service modules, macOS launchd/Keychain, TypeScript, Cloudflare Workers/Access/D1/R2, React 19, Vitest, pytest, Playwright

**Spec:** `docs/superpowers/specs/2026-10-30-mobile-transaction-editing-design.md`

## Global Constraints

- Mac SQLite remains authoritative for committed financial records; D1 commands are proposals only.
- Both David and Ariela may edit every household transaction, but production emails must never enter source, fixtures, screenshots, or logs.
- Mobile commands are one-time only and cannot create rules, archive/delete transactions, manage providers, or call arbitrary mutations.
- D1 stores no merchant, amount, description, account, institution, or provider identifiers.
- Use a dedicated Mac Access service identity and a more-specific Access policy for `/api/v1/mobile/mac/*`.
- Use integer minor-unit accounting and preserve Savings reconciliation after classification changes.
- Keep snapshot v1 readable during rollout; editing appears only with snapshot-v2 capability support.
- Pending overlays appear only in Transactions; Planning, Savings, Reports, and totals remain committed-only.
- Poll every 60 seconds while the Mac user session is awake; cancellation is allowed only before processing.
- Pending commands expire after 30 days; cloud terminal history expires after 90 days; local receipts are permanent.
- Add no paid Cloudflare product. Stop production enablement if current free limits or Access behavior no longer match the approved design.

## Review Focus

- A provider pending-to-posted update must preserve a proposal when classification did not change, but a competing category/subcategory edit must conflict (Task 1 tests).
- A Mac crash after SQLite commit but before cloud acknowledgement must never apply the command twice (Task 6 tests).
- A household email session must not invoke Mac processor routes, and a Mac service identity must not impersonate a household actor (Task 4 security tests).
- Replacement/cancellation racing with a claim must have one deterministic winner and leave an auditable state transition (Task 3 tests).
- Snapshot v1, an unsupported command version, or stale taxonomy must hide/reject editing without breaking read-only viewing (Tasks 2, 4, and 8 tests).

---

### Task 1: Classification-specific revision and atomic one-time mutation

**Files:**
- Create: `src/fintracka/migrations/019_transaction_classification_revision.sql`
- Create: `src/fintracka/classification.py`
- Modify: `src/fintracka/api.py`
- Test: `tests/test_classification.py`
- Test: `tests/test_sync.py`

**Interfaces:**
- Produces: `ClassificationConflict`, `ClassificationError`, `ClassificationChange`; `set_transaction_classification_once(connection, transaction_id, category_id, subcategory_id, observed_revision, *, actor, command_id) -> ClassificationChange`.
- Produces: `transactions.classification_revision INTEGER NOT NULL DEFAULT 0`, incremented by a SQLite trigger only when category or subcategory actually changes.

- [ ] **Step 1: Write failing migration and domain tests**

Add tests proving: existing rows start at revision zero; category/subcategory changes increment once; provider-only pending/posted updates do not increment; invalid parent/archived taxonomy and stale revision fail without mutation; Uncategorized clears category/subcategory; command application creates no learned rule; audit before/after contains actor and command ID.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" tests/test_classification.py tests/test_sync.py -q`
Expected: FAIL because the column, trigger, and service do not exist.

- [ ] **Step 3: Add the migration and atomic service**

The migration adds the column and an `AFTER UPDATE OF category_id, subcategory_id` trigger guarded by null-safe value comparison. The service validates an active category, optional active child, transaction state, and `classification_revision`; updates both IDs/provenance in one statement; writes structured audit data; and returns the new integer revision.

- [ ] **Step 4: Route existing one-time desktop classification through the shared invariant where practical**

Keep historic/future rule behavior unchanged. Ensure every existing classification path changes the revision through the database trigger without duplicating revision logic in Python.

- [ ] **Step 5: Run focused and regression tests**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" tests/test_classification.py tests/test_financial_integrity.py tests/test_subcategories.py tests/test_sync.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fintracka/migrations/019_transaction_classification_revision.sql src/fintracka/classification.py src/fintracka/api.py tests/test_classification.py tests/test_sync.py
git commit -m "feat: add classification revision invariant"
```

### Task 2: Snapshot v2 taxonomy and capability handshake

**Files:**
- Modify: `src/fintracka/remote_models.py`
- Modify: `src/fintracka/remote_snapshot.py`
- Modify: `remote/src/contract.ts`
- Modify: `frontend/src/viewer/model.ts`
- Create: `tests/fixtures/remote_snapshot_v2.json`
- Test: `tests/test_remote_snapshot.py`
- Test: `remote/tests/contract-fixture.test.ts`
- Test: `frontend/tests/viewer-model.test.ts`

**Interfaces:**
- Produces: `RemoteSnapshotV2` with `schema_version: 2`, conditionally enabled `capabilities.commands["transaction.set_classification"] = [1]`, active `taxonomy.categories[]/subcategories[]`, and transaction `classification_revision`.
- Produces: TypeScript `RemoteSnapshot = RemoteSnapshotV1 | RemoteSnapshotV2` and helpers `supportsMobileClassification(snapshot)` and `classificationTaxonomy(snapshot)`.

- [ ] **Step 1: Add failing Python and TypeScript contract tests**

Assert v1 remains accepted/read-only; v2 requires integer classification revisions, strict taxonomy parent IDs, and the exact command capability; production builder emits only active selectable taxonomy; forbidden/private-field scanning still covers v2.

- [ ] **Step 2: Run contract tests and confirm failure**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" tests/test_remote_snapshot.py -q && npm --prefix remote run test:ci -- tests/contract-fixture.test.ts && npm --prefix frontend test -- tests/viewer-model.test.ts`
Expected: FAIL on absent v2 models/helpers.

- [ ] **Step 3: Implement the versioned Python and TypeScript contracts**

Keep the strict v1 shape and fixture intact. Add explicit v2 models/union rather than optionalizing all v1 fields. The Python publisher emits v2; Worker/frontend accept both. The builder accepts a default-disabled mobile-command capability switch that Task 5 wires to persistent settings.

- [ ] **Step 4: Add taxonomy/capability snapshot building**

Publish active categories and active subcategories with stable IDs, names, types, groups, sort order, and parent IDs. Include classification revisions on every detailed transaction.

- [ ] **Step 5: Run focused tests and size check**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" tests/test_remote_snapshot.py tests/test_remote_service.py -q && npm --prefix remote run typecheck && npm --prefix remote run test:ci && npm --prefix frontend run typecheck:viewer && npm --prefix frontend test -- tests/viewer-model.test.ts`
Expected: PASS and serialized snapshot remains below 5 MiB.

- [ ] **Step 6: Commit**

```bash
git add src/fintracka/remote_models.py src/fintracka/remote_snapshot.py remote/src/contract.ts frontend/src/viewer/model.ts tests/fixtures tests/test_remote_snapshot.py remote/tests/contract-fixture.test.ts frontend/tests/viewer-model.test.ts
git commit -m "feat: publish mobile editing capabilities"
```

### Task 3: D1 member and command state machine

**Files:**
- Create: `remote/migrations/0001_mobile_commands.sql`
- Create: `remote/src/mobileCommandModel.ts`
- Create: `remote/src/mobileCommandStore.ts`
- Create: `remote/tests/mobile-command-store.test.ts`
- Modify: `remote/package.json`
- Create: `remote/vitest.config.ts`

**Interfaces:**
- Produces: `MobileCommandStore` methods `resolveMember`, `upsertMember`, `createOrReplace`, `listVisible`, `cancel`, `claim`, `complete`, and `expireAndPrune` using a `D1Database`.
- Produces: strict `CreateClassificationCommand`, `ClaimedCommand`, `CommandResult`, and safe public status types.

- [ ] **Step 1: Add failing D1 migration/state tests**

Cover schema constraints, member uniqueness, idempotent retry/digest conflict, one active command per target, explicit replacement, cancel-versus-claim, oldest-first bounded claims, lease expiry, stale claim tokens, idempotent completion, 30-day expiry, 90-day pruning, and event rows.

- [ ] **Step 2: Run Worker tests and confirm failure**

Run: `npm --prefix remote run test:ci -- tests/mobile-command-store.test.ts`
Expected: FAIL because the schema/store do not exist.

- [ ] **Step 3: Add the D1 test pool and migration**

Use Cloudflare's Workers Vitest pool so SQL migrations run against actual D1 semantics. Keep production member data out of migrations.

- [ ] **Step 4: Implement prepared-statement state transitions**

Use atomic D1 batches or single guarded `UPDATE ... RETURNING` statements. Enforce canonical JSON size/digest, partial active-target uniqueness, claim tokens, status predicates, and bounded limits.

- [ ] **Step 5: Run D1 tests, typecheck, and migration replay**

Run: `npm --prefix remote run typecheck && npm --prefix remote run test:ci`
Expected: PASS from a fresh and already-migrated test database.

- [ ] **Step 6: Commit**

```bash
git add remote/migrations remote/src/mobileCommandModel.ts remote/src/mobileCommandStore.ts remote/tests/mobile-command-store.test.ts remote/package.json remote/package-lock.json remote/vitest.config.ts
git commit -m "feat: add mobile command state machine"
```

### Task 4: Authenticated mobile-gateway APIs

**Files:**
- Create: `remote/src/mobileIdentity.ts`
- Create: `remote/src/mobileGateway.ts`
- Create: `remote/tests/mobile-gateway.test.ts`
- Modify: `remote/src/viewer.ts`
- Test: `remote/tests/viewer.test.ts`

**Interfaces:**
- Consumes: Task 2 snapshot union/taxonomy; Task 3 `MobileCommandStore`.
- Produces: browser routes `/api/v1/mobile/session`, `/api/v1/mobile/commands`, `/api/v1/mobile/commands/:id/cancel`; Mac routes `/api/v1/mobile/mac/commands/claim`, `/api/v1/mobile/mac/commands/:id/complete`, and member provisioning.

- [ ] **Step 1: Write failing route and security tests**

Test missing/spoofed identity, unknown/inactive member, exact same-origin JSON policy, bad methods/content types/body sizes, v1/no-capability snapshot, missing target, stale snapshot revision, invalid category/child, user access to Mac routes, service access to user routes, safe errors, rate/pending caps, idempotency, replacement, cancellation, claim, and completion.

- [ ] **Step 2: Run gateway tests and confirm failure**

Run: `npm --prefix remote run test:ci -- tests/mobile-gateway.test.ts tests/viewer.test.ts`
Expected: FAIL because routes/auth handlers do not exist.

- [ ] **Step 3: Implement member resolution and request hardening**

Resolve the Cloudflare-authenticated email server-side, normalize it, map to D1, and never accept actor identity in JSON. Enforce strict origin/content/fetch metadata/size checks and no permissive CORS.

- [ ] **Step 4: Implement browser and Mac handlers**

Read the active R2 snapshot for target/taxonomy/capability validation. Keep modules separate from read-only snapshot handlers. Tests supply the `COMMANDS` D1 binding locally; Task 9 adds real staging/production binding IDs only after those databases are created.

- [ ] **Step 5: Run Worker verification**

Run: `npm --prefix remote run typecheck && npm --prefix remote run test:ci`
Expected: PASS, including existing publisher/viewer tests.

- [ ] **Step 6: Commit**

```bash
git add remote/src/mobileIdentity.ts remote/src/mobileGateway.ts remote/src/viewer.ts remote/tests/mobile-gateway.test.ts remote/tests/viewer.test.ts
git commit -m "feat: expose authenticated mobile commands"
```

### Task 5: Mac command configuration and client

**Files:**
- Create: `src/fintracka/migrations/020_mobile_command_processing.sql`
- Create: `src/fintracka/mobile_command_config.py`
- Create: `src/fintracka/mobile_command_client.py`
- Test: `tests/test_mobile_command_config.py`
- Test: `tests/test_mobile_command_client.py`

**Interfaces:**
- Produces: `MobileCommandSettings` with a default-disabled capability flag; Keychain-backed `configure_mobile_commands`; `MobileCommandClient.claim(limit)`, `complete(command_id, claim_token, result)`, and `upsert_member(member_id, display_name, email)`.
- Produces: local `mobile_command_receipts` and singleton settings schema.

- [ ] **Step 1: Write failing config/client tests**

Cover HTTPS-only URL, separate secret references, rollback-safe Keychain replacement, no plaintext DB secret, native trust store, no redirects, bounded retries/timeouts, safe HTTP error mapping, strict response parsing, and redaction.

- [ ] **Step 2: Run tests and confirm failure**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" tests/test_mobile_command_config.py tests/test_mobile_command_client.py -q`
Expected: FAIL because modules/migration do not exist.

- [ ] **Step 3: Implement settings, Keychain references, and strict client**

Follow `remote_config.py` and `remote_client.py` patterns without reusing publisher credentials. Limit claim batches and request/response bytes. Wire the enabled flag into snapshot-v2 capability emission so disabling commands leaves the viewer read-only without a separate frontend build.

- [ ] **Step 4: Run focused tests**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" tests/test_mobile_command_config.py tests/test_mobile_command_client.py tests/test_remote_config.py tests/test_remote_service.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fintracka/migrations/020_mobile_command_processing.sql src/fintracka/mobile_command_config.py src/fintracka/mobile_command_client.py tests/test_mobile_command_config.py tests/test_mobile_command_client.py
git commit -m "feat: add Mac mobile command client"
```

### Task 6: Exact-once Mac processor and snapshot recovery

**Files:**
- Create: `src/fintracka/mobile_command_service.py`
- Create: `src/fintracka/financial_mutations.py`
- Modify: `src/fintracka/remote_service.py`
- Modify: `src/fintracka/classification.py`
- Modify: `src/fintracka/api.py`
- Test: `tests/test_mobile_command_service.py`
- Test: `tests/test_remote_service.py`
- Test: `tests/test_savings_goals.py`

**Interfaces:**
- Consumes: Task 1 classification service; Task 5 client/settings/receipt table.
- Produces: `process_mobile_commands(database_path, secrets, *, client_factory, now) -> MobileCommandRunResult` and `publish_unpublished_mobile_results(...)`.

- [ ] **Step 1: Write failing exact-once and fault-injection tests**

Cover empty poll, lock contention, applied/conflict/rejected results, invalid digest/version/type, duplicate receipt, crash before commit, crash after commit/before completion, completion retry, publish failure/retry, one publish per applied batch, Savings reconciliation, and safe pending-to-posted resolution.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" tests/test_mobile_command_service.py tests/test_remote_service.py tests/test_savings_goals.py -q`
Expected: FAIL because the processor does not exist.

- [ ] **Step 3: Implement claim processing under the global financial lock**

Validate every claimed field and digest again. Process each command in a SQLite transaction that includes the classification, audit, reconciliation, and permanent receipt. A duplicate receipt returns its stored result without mutation.

- [ ] **Step 4: Implement acknowledgement and publication recovery**

Extract the existing Savings reconciliation hook from `api.py` into `financial_mutations.py` so desktop routes and the command processor call one implementation. After local commit, send idempotent completion. Publish one snapshot after applied work. Keep `snapshot_published_at` null until success and retry outstanding publication next minute without reapplying commands.

- [ ] **Step 5: Run focused and full backend tests**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" tests/test_mobile_command_service.py tests/test_remote_service.py tests/test_savings_goals.py -q && "/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fintracka/mobile_command_service.py src/fintracka/financial_mutations.py src/fintracka/remote_service.py src/fintracka/classification.py src/fintracka/api.py tests/test_mobile_command_service.py tests/test_remote_service.py tests/test_savings_goals.py
git commit -m "feat: process mobile commands exactly once"
```

### Task 7: One-minute launchd schedule and administrative CLI

**Files:**
- Modify: `src/fintracka/launchd.py`
- Modify: `src/fintracka/cli.py`
- Modify: `src/fintracka/api.py`
- Modify: `frontend/src/App.tsx`
- Test: `tests/test_cli.py`
- Test: `tests/test_operations.py`
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: Task 5 configuration/client; Task 6 processor.
- Produces: LaunchAgent `com.fintracka.mobile-commands`; CLI `configure mobile-commands`, `remote commands process`, `remote commands schedule install|status|remove`, and Mac-only member provisioning; read-only local Settings status.

- [ ] **Step 1: Write failing CLI/launchd/API tests**

Assert `RunAtLoad`, `StartInterval=60`, background process, safe log paths, atomic plist replacement/rollback, Keychain stdin secret handling, status output without secrets/emails, process lock behavior, and install/remove idempotency.

- [ ] **Step 2: Run tests and confirm failure**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" tests/test_cli.py tests/test_operations.py tests/test_api.py -q`
Expected: FAIL on absent commands/schedule.

- [ ] **Step 3: Implement CLI, launchd, and read-only status**

Do not accept command credentials or member emails through the browser API. The desktop Settings surface shows enabled/loaded/last-check/error only.

- [ ] **Step 4: Run focused tests**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" tests/test_cli.py tests/test_operations.py tests/test_api.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fintracka/launchd.py src/fintracka/cli.py src/fintracka/api.py frontend/src/App.tsx tests/test_cli.py tests/test_operations.py tests/test_api.py
git commit -m "feat: schedule mobile command processing"
```

### Task 8: Mobile editing interface and pending overlays

**Files:**
- Create: `frontend/src/viewer/mobileCommands.ts`
- Create: `frontend/src/viewer/TransactionClassificationEditor.tsx`
- Modify: `frontend/src/viewer/ViewerApp.tsx`
- Modify: `frontend/src/viewer/TransactionsPage.tsx`
- Modify: `frontend/src/viewer/TransactionDrawer.tsx`
- Modify: `frontend/src/viewer/viewer.css`
- Modify: `frontend/src/viewer/api.ts`
- Modify: `frontend/e2e/remote-viewer-server.ts`
- Test: `frontend/tests/mobile-transaction-editing.test.tsx`
- Test: `frontend/tests/viewer-pages.test.tsx`
- Test: `frontend/e2e/remote-viewer.spec.ts`

**Interfaces:**
- Consumes: Task 2 v2 taxonomy/capabilities; Task 4 phone APIs.
- Produces: `MobileCommandProvider`, pending badges/overlays, explicit classification editor, replace/cancel flows, and conflict/resubmit UI.

- [ ] **Step 1: Write failing component and browser tests**

Cover v1/unsupported hidden editing, authenticated session, searchable active categories, parent-filtered optional subcategory, Uncategorized clearing, explicit Save, idempotent retry, pending overlay only in Transactions, replacement confirmation, cancellation, processing lock, terminal statuses, conflict comparison/resubmit, accessibility, narrow phone layout, and committed-only Planning/Reports totals.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm --prefix frontend test -- tests/mobile-transaction-editing.test.tsx tests/viewer-pages.test.tsx && PATH='/Users/david/Cursor Project/FinTracka/.venv/bin:'"$PATH" npm --prefix frontend run test:e2e -- e2e/remote-viewer.spec.ts`
Expected: FAIL because provider/editor do not exist.

- [ ] **Step 3: Implement the command client/provider and editor**

Keep snapshot state and command state separate. Generate/reuse idempotency keys across a retry, refresh statuses on focus/interval while relevant, and never use a pending classification in financial aggregates.

- [ ] **Step 4: Implement accessible pending/conflict presentation**

Use existing drawer patterns, touch targets, owner colors, and mobile typography. Provide visible text in addition to color/icons.

- [ ] **Step 5: Run full frontend verification**

Run: `npm --prefix frontend run typecheck && npm --prefix frontend test && npm --prefix frontend run build && PATH='/Users/david/Cursor Project/FinTracka/.venv/bin:'"$PATH" npm --prefix frontend run test:e2e`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/viewer frontend/tests/mobile-transaction-editing.test.tsx frontend/tests/viewer-pages.test.tsx frontend/e2e/remote-viewer-server.ts frontend/e2e/remote-viewer.spec.ts
git commit -m "feat: edit transaction classification on mobile"
```

### Task 9: Integrated security/fault verification and staged rollout

**Files:**
- Create: `remote/scripts/check-mobile-command-deployment.ts`
- Modify: `REMOTE_VIEWER_RUNBOOK.md`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`
- Test: `remote/tests/mobile-command-integration.test.ts`
- Test: `frontend/e2e/remote-viewer.spec.ts`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: repeatable D1 migration/deployment checks, staging security/fault gate, production enable/disable procedure, and CI coverage.

- [ ] **Step 1: Add failing integration/deployment checks**

Verify fresh/repeated migrations, D1 bindings, Access denial, path-specific service authorization, v1/v2 rollout, empty and populated queue, one-minute processing, exact-once retry, stale conflict, cancellation/replacement race, no forbidden D1 fields, 30/90-day retention, and capability-disable fallback.

- [ ] **Step 2: Run all local verification**

Run: `"/Users/david/Cursor Project/FinTracka/.venv/bin/pytest" -q && npm --prefix remote run typecheck && npm --prefix remote run test:ci && npm --prefix frontend run typecheck && npm --prefix frontend test && npm --prefix frontend run build && PATH='/Users/david/Cursor Project/FinTracka/.venv/bin:'"$PATH" npm --prefix frontend run test:e2e`
Expected: PASS before creating cloud resources.

- [ ] **Step 3: Create and verify staging infrastructure**

Create staging D1, record non-secret binding IDs, apply migrations twice, deploy gateway with commands disabled, configure synthetic identities/service policy, publish v2 synthetic data, then run the security/fault gate. Record D1 metrics and confirm free-tier headroom.

- [ ] **Step 4: Create production infrastructure with commands disabled**

Create production D1, apply migrations, deploy v1/v2-compatible gateway, configure the two member mappings through Mac-only provisioning, create/store the dedicated service token in Keychain, and configure the path-specific Mac Access policy. Do not commit identities or credentials.

- [ ] **Step 5: Install and verify the production Mac processor**

Install the 60-second LaunchAgent, prove an empty poll, run one designated harmless command through claim/apply/ack/publish, inspect local/cloud audit state, and verify read-only viewer behavior remains available with commands disabled.

- [ ] **Step 6: Enable the production capability and verify phone behavior**

Enable only `transaction.set_classification/v1`, republish, verify both members can submit while unauthorized identities cannot, confirm application within about one minute, then check cancellation, conflict, and disable-switch behavior.

- [ ] **Step 7: Update documentation and CI, then run final verification**

Document setup, recovery, disable, retention, member replacement, and cost monitoring. Run the complete local suite plus deployment checker and ensure GitHub CI is green.

- [ ] **Step 8: Commit**

```bash
git add remote/scripts/check-mobile-command-deployment.ts REMOTE_VIEWER_RUNBOOK.md README.md .github/workflows/ci.yml remote/tests/mobile-command-integration.test.ts frontend/e2e/remote-viewer.spec.ts remote/wrangler.viewer.jsonc
git commit -m "docs: operationalize mobile transaction editing"
```

## Final delivery

- Review the full branch against the spec and architecture guardrails.
- Run fresh complete backend, Worker, frontend, Playwright, migration, sensitive-data, and deployment verification.
- Push a PR, wait for green CI, merge to `main`, update the local checkout, deploy the affected Workers, install the Mac schedule, publish a fresh snapshot, and verify the live phone workflow.
- Preserve unrelated working-tree files and never expose credentials, production emails, or real financial records in commits or logs.
