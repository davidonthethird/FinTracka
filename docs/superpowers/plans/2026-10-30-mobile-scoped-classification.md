# Mobile Scoped Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the phone Viewer the desktop `1×`, `→`, and `↔` category/subcategory scopes, defaulting to non-persistent `↔`, while preserving exact-once Mac processing and v1 compatibility.

**Architecture:** Add a version 2 `transaction.set_classification` command whose canonical payload contains `scope`, while parsing v1 as one-time. The Cloudflare gateway remains a metadata queue; the Mac performs optimistic-revision validation and delegates matching/rule work to the existing desktop categorization functions inside the same SQLite transaction as the permanent receipt. The Viewer negotiates v2 capability and renders the three scope controls without browser persistence.

**Tech Stack:** Python 3.14, SQLite, pytest, TypeScript 7, React 19, Vitest, Cloudflare Workers/D1/Access, macOS Keychain/launchd.

**Spec:** `docs/superpowers/specs/2026-10-30-mobile-scoped-classification-design.md`

## Global Constraints

- Phone editors always open with `past_and_future`; scope is never persisted or synchronized.
- Scope values are exactly `one_time`, `future`, and `past_and_future` with icons `1×`, `→`, and `↔`.
- Cash withdrawals and Uncategorized always use effective `one_time`.
- Version 1 remains valid and means `one_time`; version 2 payload integrity includes `scope`.
- Matching and rule creation must reuse desktop domain behavior; do not duplicate matching logic in the Worker or Viewer.
- Rule updates, matching transaction changes, reconciliation, audit, and the permanent receipt commit atomically.
- Do not add merchant, description, account, amount, provider identifier, or rule match text to D1.
- Keep the production processor disabled until both controlled `1×` and `↔` reconciliation checks pass.

## Review Focus

- A v2 command with a valid enum but tampered scope must fail payload-digest validation; Task 2 adds the digest rejection test.
- A past/future edit whose target revision is stale must create neither rules nor transaction changes; Task 2 adds an explicit rule-count assertion.
- Historical manual classifications must not be overwritten by `↔`; Task 2 adds a protected-match test.
- A withdrawal submitted as `↔` must report effective `one_time` and create no rule; Task 2 adds this test.
- A Viewer with only v1 capability must remain read-only for the new UI rather than silently submitting v1; Task 3 adds capability-fallback coverage.

---

### Task 1: Versioned Cloud command contract and queue

**Files:**
- Modify: `remote/src/mobileCommandModel.ts`
- Modify: `remote/src/mobileCommandStore.ts`
- Modify: `remote/src/mobileGateway.ts`
- Modify: `remote/src/contract.ts`
- Test: `remote/tests/mobile-gateway.test.ts`
- Test: `remote/tests/mobile-command-store.test.ts`
- Test: `remote/tests/contract.test.ts`

**Interfaces:**
- Produces: `CategorizationScope = "one_time" | "future" | "past_and_future"`; versioned create/public/claimed commands with `command_version: 1 | 2` and normalized public/claimed `scope`; `canonicalClassificationPayload(version, categoryId, subcategoryId, scope)`.
- Produces: session capability `{ "transaction.set_classification": [1, 2] }` only when the snapshot advertises v2.

- [ ] **Step 1: Write failing v2 gateway/store/contract tests**

Add tests proving a v2 `past_and_future` command is accepted, returned, claimed, completed, and idempotently replayed with its scope; v1 is returned/claimed as `one_time`; invalid/missing/extra scope fields are rejected; v1 digest stays byte-for-byte unchanged; v2 digest changes when only scope changes; and no public response contains financial fields.

- [ ] **Step 2: Run focused Worker tests and verify RED**

Run: `cd remote && npm run test:ci -- tests/mobile-gateway.test.ts tests/mobile-command-store.test.ts tests/contract.test.ts`

Expected: FAIL because only command version 1 and the two-field canonical payload exist.

- [ ] **Step 3: Implement the versioned TypeScript model and storage normalization**

Use a discriminated union for v1/v2 create schemas. Persist v2 scope only inside bounded canonical `payload_json`; do not add a D1 financial field or duplicate scope column. Parse v1 payloads as `one_time`. Update public/claimed types, idempotency comparison, snapshot validation, and session capabilities without changing Access boundaries or retention.

- [ ] **Step 4: Run focused and complete Worker suites**

Run: `cd remote && npm run typecheck && npm run test:ci`

Expected: PASS, including all existing v1 cases.

- [ ] **Step 5: Commit Task 1**

```sh
git add remote/src remote/tests
git commit -m "feat: version mobile classification commands"
```

### Task 2: Mac scoped classification and exact-once processing

**Files:**
- Modify: `src/fintracka/mobile_command_client.py`
- Modify: `src/fintracka/mobile_command_service.py`
- Modify: `src/fintracka/classification.py`
- Modify only if needed for shared result IDs: `src/fintracka/ledger.py`
- Modify only if needed for shared result IDs: `src/fintracka/subcategories.py`
- Test: `tests/test_mobile_command_client.py`
- Test: `tests/test_mobile_command_service.py`
- Test: `tests/test_financial_integrity.py`

**Interfaces:**
- Consumes: Task 1 command fields and canonical digest rules.
- Produces: `ClaimedMobileCommand.scope: Literal["one_time", "future", "past_and_future"]` and `command_version: Literal[1, 2]`.
- Produces: `apply_scoped_classification(connection, transaction_id, category_id, subcategory_id, observed_revision, requested_scope, *, actor, command_id) -> ScopedClassificationChange`, including final target IDs/revision, requested/effective scope, and affected transaction IDs.

- [ ] **Step 1: Write failing client parser and scoped processor tests**

Add tests for v1 normalization, v2 parsing/digest, each scope, category plus subcategory rule creation, `future` not rewriting history, `past_and_future` rewriting eligible history, manual-history protection, withdrawal and Uncategorized fallback, stale revision with zero rule changes, and receipt replay with zero second application. Assert reconciliation receives every changed transaction ID and the result exposes only safe IDs/counts/scopes.

- [ ] **Step 2: Run focused Python tests and verify RED**

Run: `.venv/bin/pytest tests/test_mobile_command_client.py tests/test_mobile_command_service.py tests/test_financial_integrity.py -q`

Expected: FAIL because claimed commands and the processor only understand v1 one-time changes.

- [ ] **Step 3: Implement shared scoped domain orchestration**

Add the new domain function in `classification.py`. Validate the active target and observed revision before any mutation; use `categorize_transaction` and `assign_subcategory` for non-null scoped classifications; preserve their withdrawal/manual/matching rules; calculate changed IDs from the transaction state within the current transaction; write a mobile-scoped audit event with actor/command/scope; never commit inside the domain function.

- [ ] **Step 4: Update client validation, processor validation, results, and receipts**

Keep the v1 digest and one-time path unchanged. For v2, include scope in the canonical digest and call `apply_scoped_classification`. Reconcile every affected ID, store the receipt in the same transaction, and return requested/effective scope plus `affected_count` without financial descriptions or values.

- [ ] **Step 5: Run focused and complete Python suites**

Run: `.venv/bin/pytest tests/test_mobile_command_client.py tests/test_mobile_command_service.py tests/test_financial_integrity.py -q && .venv/bin/pytest -q`

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```sh
git add src/fintracka tests
git commit -m "feat: apply scoped mobile classifications"
```

### Task 3: Capability publication and phone scope controls

**Files:**
- Modify: `src/fintracka/remote_models.py`
- Modify: `src/fintracka/remote_snapshot.py`
- Modify: `remote/src/contract.ts`
- Modify: `frontend/src/viewer/model.ts`
- Modify: `frontend/src/viewer/mobileCommands.ts`
- Modify: `frontend/src/viewer/TransactionClassificationEditor.tsx`
- Modify: `frontend/src/viewer/viewer.css`
- Test: `tests/test_remote_snapshot.py`
- Test: `tests/test_remote_service.py`
- Test: `frontend/tests/viewer-model.test.ts`
- Test: `frontend/tests/mobile-transaction-editing.test.tsx`
- Test: `frontend/e2e/remote-viewer.spec.ts`

**Interfaces:**
- Consumes: Task 1 v2 command/session types and Task 2 safe result fields.
- Produces: snapshot capability `{ "transaction.set_classification": (1, 2) }`; phone `ClassificationInput.scope`; editor scope control defaulting to `past_and_future` on every open.

- [ ] **Step 1: Write failing snapshot/model/UI tests**

Assert snapshots publish `[1, 2]`; `[1]` snapshots parse but do not enable the new editor; `[1, 2]` enables it; editor markup exposes the three exact icons/labels with `↔` selected by default; no local/session storage API is called; withdrawal and Uncategorized show/submit one-time; a pending proposal renders its scope; replacement submits the selected scope.

- [ ] **Step 2: Run focused frontend/snapshot tests and verify RED**

Run: `.venv/bin/pytest tests/test_remote_snapshot.py tests/test_remote_service.py -q && cd frontend && npm test -- tests/viewer-model.test.ts tests/mobile-transaction-editing.test.tsx`

Expected: FAIL because snapshots and the Viewer expose only v1 and the editor hard-codes one-time.

- [ ] **Step 3: Publish v2 capability and implement the non-persistent phone control**

Accept only absent, `(1,)`, or `(1, 2)` capability tuples. Make the editor state initialize/reset to `past_and_future` when opened, with no storage reads/writes. Render the three controls and explanatory copy; force/disable one-time for withdrawals and when category is null. Submit v2 commands with effective scope and display command scope in proposal/status UI.

- [ ] **Step 4: Add responsive styling and Viewer E2E assertions**

Keep the controls inside the existing drawer width at 320/375/390/430 px, maintain 44px touch targets, visible focus, and text/tooltips so meaning is not color-only or icon-only.

- [ ] **Step 5: Run frontend, snapshot, build, and complete suites**

Run: `.venv/bin/pytest tests/test_remote_snapshot.py tests/test_remote_service.py -q && cd frontend && npm test && npm run typecheck:viewer && npm run build:viewer`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```sh
git add src/fintracka/remote_models.py src/fintracka/remote_snapshot.py remote/src/contract.ts frontend/src frontend/tests frontend/e2e tests/test_remote_snapshot.py tests/test_remote_service.py
git commit -m "feat: add mobile categorization scopes"
```

### Task 4: Deploy, reconcile, enable, and hand off

**Files:**
- Modify: `REMOTE_VIEWER_RUNBOOK.md`
- Modify: `CLOUDFLARE_MOBILE_EDITING_HANDOFF.md`
- Modify: `remote/wrangler.viewer.jsonc` (already contains completed Mac AUD configuration)

**Interfaces:**
- Consumes: Tasks 1–3 v2 Worker, snapshot, Mac processor, and Viewer UI.
- Produces: deployed v2-capable staging/production Viewer; verified production receipts/rules; enabled one-minute LaunchAgent.

- [ ] **Step 1: Run predeployment security and regression gates**

Run: `.venv/bin/pytest -q && cd remote && npm run typecheck && npm run test:ci && npm run check:deployment -- --require-mac-access && cd ../frontend && npm test && npm run typecheck && npm run build:viewer`

Expected: PASS with no credential or financial data in output.

- [ ] **Step 2: Deploy with processing still disabled**

Deploy staging and production Viewer Workers, publish a fresh v2-capable snapshot, and rerun the missing/fake credential `401/403` checks. Confirm the human Viewer remains Access-protected.

- [ ] **Step 3: Reconcile controlled one-time and past/future commands**

Using authenticated household UI, choose known harmless transactions. Process manually while scheduling remains off. For `1×`, verify one target/revision/receipt and no rule. For `↔`, record the expected matching IDs first, then verify only eligible matches changed, manual/withdrawal rows did not, the learned rules match desktop format, the result count is exact, and replay does nothing.

- [ ] **Step 4: Enable and install the processor**

Run:

```sh
.venv/bin/python -m fintracka.cli remote commands enable
.venv/bin/python -m fintracka.cli remote commands schedule install
.venv/bin/python -m fintracka.cli remote commands schedule status
.venv/bin/python -m fintracka.cli remote commands status
```

Expected: enabled, installed, loaded, `StartInterval=60`, and no error code after an empty poll.

- [ ] **Step 5: Update runbooks and commit deployment configuration/docs**

Record the v2 scope behavior, forced one-time cases, validation evidence without private IDs/emails, token expiry date, rollback commands, and deployed Worker version IDs.

```sh
git add REMOTE_VIEWER_RUNBOOK.md CLOUDFLARE_MOBILE_EDITING_HANDOFF.md remote/wrangler.viewer.jsonc docs/superpowers/specs/2026-10-30-mobile-scoped-classification-design.md docs/superpowers/plans/2026-10-30-mobile-scoped-classification.md
git commit -m "docs: complete scoped mobile editing rollout"
```

- [ ] **Step 6: Final branch review and integration**

Review the entire branch against this plan/spec, fix all Critical/Important findings with RED→GREEN tests, rerun every suite, push the branch, open a PR, wait for CI, and merge only when green.
