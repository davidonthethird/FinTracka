# Apple Receipt Hybrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a free, reliable Apple-only receipt pipeline with evidence-validated iPhone extraction and automatic private-iCloud/Mac refinement for scans that need it.

**Architecture:** Extend the existing one-use Shortcut import with a backwards-compatible v2 flat-string contract and a shared deterministic validator. Invalid or unreconciled v2 imports create an opaque refinement job; the Shortcut saves images to a private iCloud queue, and the existing Mac Access identity runs a once-per-minute Python coordinator plus a Swift Vision/Foundation Models helper to complete the job. Images never enter Cloudflare and all drafts remain editable and explicitly matched by a person.

**Tech Stack:** React 19, TypeScript, Zod, Cloudflare Worker/D1/Access, Python 3.13, Swift 6, Vision `RecognizeDocumentsRequest`, Foundation Models guided generation, macOS LaunchAgent, Apple Shortcuts, private shared iCloud Drive

**Spec:** `docs/superpowers/specs/2026-11-04-apple-receipt-hybrid-design.md`

## Global Constraints

- Keep v1 captures working during rollout; canonical v2 Shortcut name is `FinTracka Receipt Scanner`.
- Shortcut transport uses flat `text` and `model_result` strings, never nested item Dictionaries.
- Use Model must be On-Device only; no hosted model, PCC, ChatGPT, paid OCR, or Windows OCR path.
- Every accepted model value requires exact OCR evidence and deterministic integer-cent validation.
- The public Worker route remains text-only, one-use-token protected, bounded, and member scoped.
- Original images may leave the phone only for the approved private shared iCloud queue when refinement is required.
- Queue manifests contain no credentials, identity, host, OCR text, transaction data, or bank data.
- Mac Access secrets remain in macOS Keychain.
- Successful queue packages are deleted; failed packages are retained for seven days.
- The Mac worker runs at login and every 60 seconds while awake, processing at most three jobs serially.
- Manual edit/review is always available. Nothing automatically matches or mutates the financial ledger.

## Review Focus

- A model value that is plausible but absent from OCR evidence must be excluded and visibly flagged.
- Discounts, negative lines, tax, tip, fees, and rounding must reconcile in cents without silently changing item amounts.
- A replay, expired lease, wrong member, missing iCloud package, or changed input digest must not create or overwrite a refinement.
- Prompt-like receipt text must remain inert data and cannot choose URLs, contracts, actions, or categories.
- Mac asleep, Apple Intelligence unavailable, iCloud delayed, and browser refresh must all preserve a usable manual-review path without empty or duplicate drafts.

---

### Task 1: Add the v2 evidence-backed receipt contract

**Files:**
- Create: `remote/src/receiptInterpretation.ts`
- Create: `remote/tests/receipt-interpretation.test.ts`
- Modify: `remote/src/receiptShortcutModel.ts`
- Modify: `remote/tests/receipt-shortcut-store.test.ts`
- Modify: `remote/tests/receipt-shortcut-gateway.test.ts`

**Interfaces:**
- Produces: `ReceiptShortcutCaptureV2Schema`, `ReceiptInterpretationSchema`
- Produces: `validateReceiptInterpretation(rawText: string, modelResult: string): ReceiptValidationResult`
- Produces: `ReceiptValidationResult` with `status`, `issues`, and evidence-backed `receipt`
- Preserves: v1 pages/text normalization and canonical replay digest

- [ ] **Step 1: Write failing schema and validator tests** for v1 compatibility, v2 bounds, exact evidence, unsupported-value removal, duplicate evidence, discounts/tax/tip/fees arithmetic, prompt injection, malformed JSON, and integer-cent parsing.
- [ ] **Step 2: Run `cd remote && npm test -- tests/receipt-interpretation.test.ts tests/receipt-shortcut-store.test.ts tests/receipt-shortcut-gateway.test.ts` and require the new tests to fail for missing v2 behavior.**
- [ ] **Step 3: Implement the strict v2 capture and interpretation schemas plus `validateReceiptInterpretation`** using normalized substring matching and integer cents only; no model or fuzzy inference runs in the Worker.
- [ ] **Step 4: Extend canonicalization and the upload response** with `validation_status`, bounded issue codes, and an optional refinement ID placeholder while leaving v1 response behavior compatible.
- [ ] **Step 5: Run the focused test command and require zero failures.**
- [ ] **Step 6: Commit `feat: validate evidence-backed receipt interpretations`.**

### Task 2: Add refinement jobs and Mac-only APIs

**Files:**
- Create: `remote/migrations/0006_receipt_refinements.sql`
- Create: `remote/src/receiptRefinementStore.ts`
- Create: `remote/src/receiptRefinementGateway.ts`
- Create: `remote/tests/receipt-refinement-store.test.ts`
- Create: `remote/tests/receipt-refinement-gateway.test.ts`
- Modify: `remote/src/receiptShortcutStore.ts`
- Modify: `remote/src/receiptShortcutGateway.ts`
- Modify: `remote/src/mobileGateway.ts`
- Modify: `remote/src/viewer.ts`

**Interfaces:**
- Consumes: Task 1 `validateReceiptInterpretation`
- Produces: `ReceiptRefinementStore.createForImport(...)`, `.claim(...)`, `.complete(...)`, `.fail(...)`
- Produces: `POST /api/v1/mobile/mac/receipt-refinements/claim`
- Produces: `POST /api/v1/mobile/mac/receipt-refinements/{id}/complete|fail`
- Produces: browser import state `ready | pending_refinement | refinement_failed`

- [ ] **Step 1: Write failing D1/store tests** for creation only on `needs_refinement`, five-minute leases, three-job claim limit, wrong-member isolation, input-digest binding, identical completion replay, changed completion rejection, safe failure codes, and seven-day expiry.
- [ ] **Step 2: Write failing gateway tests** proving Mac routes require the existing Mac Access audience and browser/public routes cannot claim or complete jobs.
- [ ] **Step 3: Run the two focused test files and verify failure.**
- [ ] **Step 4: Add migration 0006 and implement the minimal store/gateway** by reusing the existing Mac authentication branch and response/error conventions.
- [ ] **Step 5: Integrate upload validation** so a v2 import creates at most one bound refinement job and returns its opaque ID/status idempotently.
- [ ] **Step 6: Run all remote tests and TypeScript typecheck; require zero failures.**
- [ ] **Step 7: Commit `feat: add receipt refinement jobs`.**

### Task 3: Make receipt review refinement-aware

**Files:**
- Modify: `frontend/src/viewer/receipts/receiptShortcutApi.ts`
- Modify: `frontend/src/viewer/receipts/ReceiptShortcutImportPage.tsx`
- Modify: `frontend/src/viewer/receipts/receiptDraftBuilder.ts`
- Modify: `frontend/src/viewer/viewer.css`
- Modify: `frontend/tests/receipt-shortcut-pages.test.tsx`
- Modify: `frontend/e2e/remote-viewer.spec.ts`

**Interfaces:**
- Consumes: Task 2 import state and validated receipt
- Produces: editable draft from validated fields without reinterpreting model output in the browser
- Produces: pending/failed/refined status UI with manual edit, retry, discard, and refresh

- [ ] **Step 1: Write failing component tests** for accepted direct import, unsupported-field warning, pending Mac refinement, Mac-off manual review, failed refinement, refresh-to-refined, discard, and deterministic duplicate navigation.
- [ ] **Step 2: Run the focused frontend test and verify failure.**
- [ ] **Step 3: Implement the smallest state-aware import page** using the existing receipt provider/review screen; do not create a parallel receipt editor.
- [ ] **Step 4: Add the Playwright flow** using synthetic imports only; assert zero empty/duplicate drafts.
- [ ] **Step 5: Run frontend tests, typecheck, build, and the focused Playwright flow; require zero failures.**
- [ ] **Step 6: Commit `feat: show receipt refinement status`.**

### Task 4: Add the Mac queue coordinator and protected client

**Files:**
- Create: `src/fintracka/receipt_refinement_client.py`
- Create: `src/fintracka/receipt_refinement_service.py`
- Create: `tests/test_receipt_refinement_client.py`
- Create: `tests/test_receipt_refinement_service.py`
- Modify: `src/fintracka/mobile_command_config.py`
- Modify: `src/fintracka/cli.py`
- Modify: `src/fintracka/launchd.py`
- Modify: `tests/test_cli.py`
- Modify: `tests/test_operations.py`

**Interfaces:**
- Produces: `ReceiptRefinementClient.from_settings(...)`, `.claim(limit=3)`, `.complete(...)`, `.fail(...)`
- Produces: `process_receipt_refinements(data_dir, queue_dir, keychain, helper)`
- Produces: CLI `remote receipts process` and schedule install/status/remove
- Consumes: existing mobile-command gateway URL and Keychain Access references

- [ ] **Step 1: Write failing client tests** for Access headers, strict response parsing, retries, safe error mapping, no secret logging, and digest/idempotency fields.
- [ ] **Step 2: Write failing service tests** for valid package processing, manifest/path traversal rejection, missing page, helper unavailable, success deletion, seven-day failed retention, no unrelated-file deletion, and at-most-three serial jobs.
- [ ] **Step 3: Write failing CLI/LaunchAgent tests** requiring `RunAtLoad`, `StartInterval=60`, redacted logs, and rollback-safe installation.
- [ ] **Step 4: Run the focused Python tests and verify failure.**
- [ ] **Step 5: Implement the client/coordinator/CLI by reusing existing urllib, Keychain, and LaunchAgent patterns; add no dependency.**
- [ ] **Step 6: Run the focused Python tests and the full Python suite; require zero new failures.**
- [ ] **Step 7: Commit `feat: process private receipt refinement queue`.**

### Task 5: Add the native Swift Vision/Foundation Models helper

**Files:**
- Create: `native/receipt-refiner/Package.swift`
- Create: `native/receipt-refiner/Sources/ReceiptRefiner/main.swift`
- Create: `native/receipt-refiner/Sources/ReceiptRefiner/ReceiptModels.swift`
- Create: `native/receipt-refiner/Sources/ReceiptRefiner/ReceiptRecognizer.swift`
- Create: `native/receipt-refiner/Sources/ReceiptRefiner/ReceiptInterpreter.swift`
- Create: `native/receipt-refiner/Tests/ReceiptRefinerTests/ReceiptRefinerTests.swift`
- Create: `scripts/build-receipt-refiner.sh`
- Modify: `pyproject.toml`

**Interfaces:**
- Consumes: a package directory containing the strict v1 manifest and ordered page images
- Produces: one JSON v2 interpretation on stdout; diagnostics/error codes on stderr
- Produces: typed exit codes `MODEL_UNAVAILABLE`, `VISION_FAILED`, `INVALID_PACKAGE`, `UNRECONCILED`

- [ ] **Step 1: Write failing Swift tests** for manifest/page ordering, Vision-result-to-evidence mapping, chunk merge without duplicate lines, arithmetic preservation, prompt text remaining inert, and model-unavailable behavior.
- [ ] **Step 2: Run `cd native/receipt-refiner && swift test` and verify failure.**
- [ ] **Step 3: Implement typed receipt models and package validation** with Foundation Models guarded by platform availability.
- [ ] **Step 4: Implement document recognition and guided generation** using `RecognizeDocumentsRequest`, a fixed prompt, fixed output schema, bounded chunks, and no network fallback.
- [ ] **Step 5: Add the build script** that compiles a release binary into FinTracka's data tools directory without committing a binary.
- [ ] **Step 6: Run Swift tests and a synthetic command-line fixture; require deterministic JSON and zero failures.**
- [ ] **Step 7: Commit `feat: add native Apple receipt refiner`.**

### Task 6: Define, distribute, and verify the canonical Shortcut

**Files:**
- Modify: `frontend/src/viewer/receipts/receiptShortcutApi.ts`
- Modify: `frontend/src/viewer/receipts/ReceiptCapturePage.tsx`
- Modify: `frontend/tests/receipt-shortcut-pages.test.tsx`
- Rewrite: `docs/receipt-shortcut-setup.md`
- Modify: `docs/receipt-processing-runbook.md`
- Create: `docs/receipt-shortcut-v2-actions.md`
- Create: `scripts/verify-receipt-hybrid.sh`

**Interfaces:**
- Produces: stable URL invocation for `FinTracka Receipt Scanner`
- Produces: exact v2 action recipe with On-Device model, flat JSON string, conditional iCloud Save File, and review URL
- Produces: signed-Shortcut installation/update acceptance procedure

- [ ] **Step 1: Write failing frontend tests** requiring the canonical name, advertised version 2, and install/update state without numbered-name fallback.
- [ ] **Step 2: Update the exact Shortcut recipe** including the output Dictionary schema, exact-evidence instruction, flat serialization, conditional queue save, manifest, and failure messages.
- [ ] **Step 3: Update privacy/runbook documentation** to replace the obsolete phone-only-image claim with the approved conditional iCloud boundary and rollback steps.
- [ ] **Step 4: Add `verify-receipt-hybrid.sh`** to run remote, frontend, Python, Swift, typecheck, build, audits, and `git diff --check` without accessing private receipt photos.
- [ ] **Step 5: Run the verification script and require zero receipt-specific failures.**
- [ ] **Step 6: Build and inspect the Shortcut on a staging phone, export and sign it, then complete the physical-device matrix on both phones.**
- [ ] **Step 7: Commit `docs: add canonical Apple receipt scanner rollout`.**

### Task 7: Deploy behind gates and run private acceptance

**Files:**
- Modify: `remote/wrangler.viewer.jsonc`
- Modify: `docs/receipt-processing-runbook.md`

**Interfaces:**
- Consumes: Tasks 1–6 and existing staging/production Access applications
- Produces: staged feature flags and a redacted acceptance record

- [ ] **Step 1: Apply migration 0006 twice in staging** and require the second application to report no pending migration.
- [ ] **Step 2: Deploy with refinement disabled**, verify existing v1 capture, then enable v2/refinement only in staging.
- [ ] **Step 3: Run the Access matrix** proving only the existing exact text-upload route is public and every Mac refinement route requires the dedicated Mac audience.
- [ ] **Step 4: Run the private real-receipt benchmark** without committing images/text; require every visible monetary line/summary to be recovered or specifically flagged, never silently omitted.
- [ ] **Step 5: Run the Mac-off/Mac-on/iCloud deletion matrix and both-member isolation matrix.**
- [ ] **Step 6: Record only redacted pass/fail evidence and version IDs in the runbook.**
- [ ] **Step 7: Enable production only after user review of one harmless live receipt; otherwise leave the feature gated.**

## Self-review record

- Spec coverage: phone extraction, evidence/arithmetic validation, conditional iCloud queue, Mac refinement, retention, stable Shortcut, manual review, security, deployment, and real-device acceptance each map to Tasks 1–7.
- Type consistency: v2 capture and validation are defined once in Task 1; D1 and frontend consume that shape; the Mac helper emits the same interpretation shape.
- Ponytail check: existing scan sessions, Access identity, D1 import, receipt editor, Keychain client, urllib client, and LaunchAgent patterns are reused. No new JavaScript/Python dependency, Windows worker, image API, parallel editor, or speculative category model is added.
- Non-automatable gate: Shortcut construction/signing, shared-folder permissions, private photos, and production deployment require physical-device/account interaction and remain explicit acceptance steps rather than claimed automated success.
