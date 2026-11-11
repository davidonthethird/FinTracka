# iCloud Receipt Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unreliable Shortcut URL/JSON upload with a durable private-iCloud handoff while keeping both Apple model comparisons on the iPhone and making completed scans discoverable after the Mac relays them.

**Architecture:** The viewer creates a member-bound opaque handoff and launches Shortcut version 4 with only that ID. The Shortcut performs per-page OCR, runs On Device and Private Cloud Compute, and writes photos plus separate bounded text files to the existing shared iCloud queue, with a strict manifest written last. The existing Mac scheduler validates and relays the package through its Access-protected identity; the Worker reuses the current v3 comparison/import path exactly once. The Mac may use Apple Vision only when OCR is blank and never runs either comparison model.

**Tech Stack:** React 19, TypeScript, Zod, Cloudflare Worker/D1/Access, Python 3.13 standard library, Swift 6 Vision, macOS LaunchAgent, Apple Shortcuts, private shared iCloud Drive

**Spec:** `docs/superpowers/specs/2026-11-11-icloud-receipt-handoff-design.md`

## Global Constraints

- Keep v1–v3 imports working during rollout; advertise version 4 only after its dependencies are deployed.
- The Shortcut contains no HTTP action, callback URL, clipboard action, persistent credential, bearer token, household identity, or bank data.
- The Shortcut writes separate UTF-8 OCR/model files and a scalar manifest written last; never interpolate model output into JSON.
- Run OCR once per selected page inside `Repeat with Each`, then combine ordered page results.
- Both Apple model routes run on the iPhone/Apple path selected in Shortcuts. The Mac never runs Foundation Models for comparison.
- Reuse the existing comparison, evidence validation, exact-cent arithmetic, benchmark, review, Access client, queue directory, and LaunchAgent.
- Mac completion requires Access authentication. A handoff ID alone grants nothing.
- Preserve member/household isolation and exact-once completion. Never delete a package before a confirmed idempotent success.
- Original images may exist only on the Apple devices/private shared iCloud queue and are deleted after successful relay. Cloudflare/D1 remains text-only.
- Nothing automatically matches a bank transaction or mutates the ledger.
- Do not claim completion until the physical acceptance matrix passes on David's and Ariela's iPhones.

## Review Focus

- A partially synchronized iCloud directory must wait without being marked invalid, moved, or deleted.
- A package must survive a sleeping Mac, closed browser, lost completion response, and repeated identical processing without creating a duplicate import.
- A changed replay, wrong member, expired handoff, symlink, path escape, extra file, oversized file, malformed manifest, or malformed UTF-8 must fail closed.
- Blank phone OCR may invoke only Mac Apple Vision OCR; both saved iPhone model routes and their statuses must remain unchanged.
- The viewer must let the owning member find pending, failed, and completed scans after the original scan tab is gone, without exposing another member's handoffs.

---

### Task 1: Persist member-bound queue handoffs

**Files:**
- Create: `remote/migrations/0008_receipt_queue_handoffs.sql`
- Create: `remote/src/receiptQueueHandoffStore.ts`
- Create: `remote/tests/receipt-queue-handoff-store.test.ts`
- Modify: `remote/src/receiptShortcutStore.ts`
- Modify: `remote/tests/receipt-shortcut-store.test.ts`

**Interfaces:**
- Produces: `ReceiptQueueHandoffStore.create(...)`, `.listForMember(...)`, `.listActiveIds(...)`, `.complete(...)`
- Produces: status `pending | processing | completed | failed`, optional `importId`, safe `errorCode`
- Consumes: a new package completion adapter in `ReceiptShortcutStore` that accepts a session digest and strict v3 capture without a public token
- Preserves: legacy token upload, v1–v3 schemas, benchmark/refinement creation, active-import limits, and canonical body digest behavior

- [ ] **Step 1: Write failing migration/store tests** for UUID creation, member-scoped listing, seven-day expiry, active-ID bounds, completion against an expired public token, identical replay, changed replay, wrong member, unknown handoff, and one import per handoff.
- [ ] **Step 2: Run `cd remote && npm test -- --run tests/receipt-queue-handoff-store.test.ts tests/receipt-shortcut-store.test.ts` and require the new tests to fail.**
- [ ] **Step 3: Add migration `0008_receipt_queue_handoffs.sql`** with one row per originating scan session, unique session and import references, strict statuses, canonical completion digest, member indexes, and seven-day cleanup indexes. Do not extend the legacy public upload token's lifetime.
- [ ] **Step 4: Extract the existing validated import transaction into one internal `ReceiptShortcutStore` method** used by both `createImport(token, capture)` and queue completion. Parameterize only the import expiry needed for queue imports; do not copy comparison, validation, benchmark, or refinement logic.
- [ ] **Step 5: Implement the handoff store** so completion validates the existing v3 schema before the transaction, binds to the original session digest, creates a seven-day review import, and returns the existing import for an identical replay.
- [ ] **Step 6: Run the focused tests, then `cd remote && npm test -- --run && npm run typecheck`; require zero failures.**
- [ ] **Step 7: Commit `feat: persist private receipt queue handoffs`.**

### Task 2: Add authenticated browser and Mac handoff APIs

**Files:**
- Create: `remote/src/receiptQueueHandoffGateway.ts`
- Create: `remote/tests/receipt-queue-handoff-gateway.test.ts`
- Modify: `remote/src/receiptShortcutGateway.ts`
- Modify: `remote/src/mobileGateway.ts`
- Modify: `remote/src/viewer.ts`
- Modify: `remote/tests/receipt-shortcut-gateway.test.ts`
- Modify: `remote/tests/mobile-gateway.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/mobile/receipt-scan-sessions` version-4 response with `handoff_id`
- Produces: `GET /api/v1/mobile/receipt-queue-handoffs` and `GET /api/v1/mobile/receipt-queue-handoffs/{id}` for the authenticated owning member
- Produces: `GET /api/v1/mobile/mac/receipt-queue-handoffs/active`
- Produces: `POST /api/v1/mobile/mac/receipt-queue-handoffs/{id}/complete`
- Preserves: legacy `/api/v1/mobile/shortcut/receipt-imports` during rollback

- [ ] **Step 1: Write failing gateway tests** for version-4 creation, member-scoped list/status, pending-to-ready review path, Mac Access requirement, missing/incorrect Access claims, body limit, same-body replay, changed-body conflict, expired handoff, and legacy upload compatibility.
- [ ] **Step 2: Run `cd remote && npm test -- --run tests/receipt-queue-handoff-gateway.test.ts tests/receipt-shortcut-gateway.test.ts tests/mobile-gateway.test.ts` and verify failure.**
- [ ] **Step 3: Implement the browser routes** using the existing authenticated claims and error mapping. Return only opaque IDs, timestamps, statuses, safe errors, and owned review paths.
- [ ] **Step 4: Implement the Mac routes** inside the existing Mac Access branch. Accept only a strict bounded v3 capture and never accept photos, a browser token, or arbitrary package metadata.
- [ ] **Step 5: Add a rollout binding** that permits version-4 support to be deployed while session advertisement stays off. Keep the smallest existing config pattern; do not add a new configuration system.
- [ ] **Step 6: Run focused tests, all remote tests, typecheck, and `npm run check:deployment`; require zero failures.**
- [ ] **Step 7: Commit `feat: expose protected receipt queue handoffs`.**

### Task 3: Relay ready iCloud packages with the existing Mac process

**Files:**
- Modify: `src/fintracka/mobile_command_client.py`
- Modify: `src/fintracka/receipt_refinement_service.py`
- Modify: `src/fintracka/cli.py`
- Modify: `tests/test_mobile_command_client.py`
- Modify: `tests/test_receipt_refinement_service.py`
- Modify: `tests/test_mobile_command_service.py`

**Interfaces:**
- Produces: `active_receipt_queue_handoff_ids()` and `complete_receipt_queue_handoff(id, capture)` on the existing client
- Produces: strict `receipt_queue_capture/v1` parser and deterministic v3 capture assembler
- Reuses: `process_configured_receipt_refinements(...)`, the existing queue path, Keychain identity, scheduler, page/text limits, and redacted result counters

- [ ] **Step 1: Write failing client tests** for Access headers, active-ID bounds, strict response parsing, request/body bounds, timeout, safe errors, and no credential/model text in logs.
- [ ] **Step 2: Write failing service tests** for a complete package, manifest-written-last readiness, a package missing one late iCloud file, stable-file settling, exact filenames, UTF-8 errors, status/output consistency, 1–12 ordered pages, symlink/traversal/extra-file rejection, page/package size caps, three-package serial limit, unchanged retry, changed replay retention, success deletion, terminal-failure move, and seven-day retention.
- [ ] **Step 3: Add a Mac-off test** that creates a package, runs no processor until after the browser token expires, then processes it once and proves one ready import is produced.
- [ ] **Step 4: Run `PYTHONPATH=. python -m pytest tests/test_mobile_command_client.py tests/test_receipt_refinement_service.py tests/test_mobile_command_service.py -q` and require the new tests to fail.**
- [ ] **Step 5: Implement the client methods and strict parser** in the existing files. Ignore an incomplete/unsettled pending package; reject only a complete, stable, invalid package. Derive the v3 idempotency key from the validated package content.
- [ ] **Step 6: Extend the existing scheduled processing call** to handle at most three queue handoffs and the existing refinement jobs serially. Do not add a LaunchAgent, thread, watcher, dependency, or second Keychain credential.
- [ ] **Step 7: Run the focused tests and `PYTHONPATH=. python -m pytest tests -q`; require zero failures.**
- [ ] **Step 8: Commit `feat: relay receipt packages from private iCloud`.**

### Task 4: Restrict the native helper to OCR-only fallback for handoffs

**Files:**
- Modify: `native/receipt-refiner/Sources/ReceiptRefiner/main.swift`
- Create: `native/receipt-refiner/Tests/ReceiptRefinerTests/OcrOnlyTests.swift`
- Modify: `tests/test_receipt_refinement_service.py`
- Modify: `scripts/build-receipt-refiner.sh`

**Interfaces:**
- Produces: `fintracka-receipt-refiner --ocr-only <package>` returning `{ "text": "..." }`
- Preserves: the existing refinement command for legacy pending refinement jobs until version-4 rollout is complete
- Guarantees: OCR-only code path does not inspect or initialize `SystemLanguageModel`

- [ ] **Step 1: Write failing Swift tests** for page ordering, page markers, blank Vision result, language correction, invalid package, and an injectable assertion that OCR-only never creates a language-model session.
- [ ] **Step 2: Write a failing Python coordinator test** proving helper invocation occurs only when `ocr.txt` is blank and uses `--ocr-only`; nonblank OCR must never invoke the helper.
- [ ] **Step 3: Run `cd native/receipt-refiner && swift test` and the focused Python test; require failure.**
- [ ] **Step 4: Split the current command dispatch at `main`** so `--ocr-only` validates pages and runs Vision only, while the legacy command retains current behavior. Share package/page validation rather than copy it.
- [ ] **Step 5: Update the build/self-test script** to exercise both command modes without private photos.
- [ ] **Step 6: Run Swift tests, helper self-tests, and the focused Python tests; require zero failures.**
- [ ] **Step 7: Commit `feat: add receipt OCR-only fallback`.**

### Task 5: Build and inspect canonical Shortcut version 4

**Files:**
- Create: `shortcuts/FinTracka Receipt Scanner.plist`
- Create: `scripts/build-receipt-shortcut-v4.py`
- Create: `scripts/verify-receipt-shortcut-v4.py`
- Rewrite: `docs/receipt-shortcut-v3-actions.md` as `docs/receipt-shortcut-v4-actions.md`
- Modify: `docs/receipt-shortcut-setup.md`

**Interfaces:**
- Consumes: two-line Shortcut input containing `receipt_queue_handoff/v1` and UUID `handoff_id`
- Produces: `receipt_queue_capture/v1` package in `iCloud Drive/FinTracka Receipt Queue/pending/<handoff-id>`
- Produces: one canonical signed `FinTracka Receipt Scanner.shortcut`

- [ ] **Step 1: Write the Shortcut action contract test first.** It must fail unless the plist has: 1–12 camera/photo-library selection; `Repeat with Each` page OCR using `Repeat Item`; explicit page markers; two fixed Apple model invocations; independent status and duration capture; separate page/OCR/on-device/PCC saves; `manifest.txt` saved last; cancellation/error messages; and no network, `Open URL`, callback, clipboard, JavaScript, shell, or persistent-secret action.
- [ ] **Step 2: Build the plist with Shortcuts Playground conventions:** fresh action UUIDs, native icon resolution, comments for each phase, stable canonical name, bounded menus, and no nested Shortcut invocation.
- [ ] **Step 3: Make output serialization boring:** model results go directly to their text files; the manifest contains only fixed keys and validated scalar variables. Do not construct JSON from model output.
- [ ] **Step 4: Run the repository action-contract verifier and Craig Loop validator (maximum 5 repair loops); require zero findings.**
- [ ] **Step 5: Sign for `Anyone`, archive the signed artifact, verify a zero exit code and nonzero file, then inspect the signed plist/action inventory again.**
- [ ] **Step 6: Update setup/action documentation** with the exact expected action order, shared-folder prerequisite for David and Ariela, install/replace steps, permission prompts, and removal of all numbered copies only after acceptance.
- [ ] **Step 7: Commit `feat: build iCloud receipt handoff shortcut`.**

### Task 6: Make queued scans visible and durable in the viewer

**Files:**
- Modify: `frontend/src/viewer/receipts/receiptShortcutApi.ts`
- Modify: `frontend/src/viewer/receipts/ReceiptCapturePage.tsx`
- Modify: `frontend/src/viewer/receipts/ReceiptInboxPage.tsx`
- Modify: `frontend/src/viewer/viewer.css`
- Modify: `frontend/tests/receipt-shortcut-pages.test.tsx`
- Modify: `frontend/e2e/remote-viewer.spec.ts`

**Interfaces:**
- Consumes: version-4 session/handoff status/list routes
- Produces: Shortcut input containing only contract and handoff ID
- Produces: compact `Waiting for Mac`, `Processing`, `Ready`, and safe `Failed` rows in the existing receipt inbox
- Preserves: legacy import review and benchmark comparison components

- [ ] **Step 1: Write failing component tests** for version-4 creation, minimal Shortcut input, no upload URL/token in the launch payload, pending status, closed-page rediscovery, automatic ready navigation, failed retry guidance, member isolation, and legacy version fallback.
- [ ] **Step 2: Write a failing Playwright flow** that queues a scan, destroys/recreates the page, completes it through the synthetic Mac endpoint, and opens exactly one review import from the inbox.
- [ ] **Step 3: Run `cd frontend && npm test -- --run tests/receipt-shortcut-pages.test.tsx` and the focused Playwright test; require failure.**
- [ ] **Step 4: Update `ReceiptScanSession` to a versioned union** and make version 4 pass only contract/handoff ID to `shortcuts://run-shortcut`. Never pass the browser token or an upload URL.
- [ ] **Step 5: Add the smallest queued-scan list to the existing inbox** and reuse the current import/review route when ready. Do not create a second receipt editor or background state system.
- [ ] **Step 6: Update user copy** to say the iPhone saves privately to shared iCloud and the Mac relays it; remove the obsolete `30-minute one-time connection` statement for version 4.
- [ ] **Step 7: Run frontend tests, typecheck, viewer build, and focused Playwright; require zero failures.**
- [ ] **Step 8: Commit `feat: show durable receipt handoffs`.**

### Task 7: Stage, verify, deploy, and accept on both phones

**Files:**
- Modify: `scripts/verify-receipt-hybrid.sh`
- Modify: `docs/receipt-processing-runbook.md`
- Modify: `docs/receipt-shortcut-setup.md`
- Create: `docs/receipt-shortcut-v4-physical-matrix.md`

**Interfaces:**
- Produces: one repeatable automated gate and one signed physical-device acceptance record
- Produces: staged rollout and rollback instructions that leave pending packages recoverable

- [ ] **Step 1: Extend `scripts/verify-receipt-hybrid.sh`** to run remote tests/typecheck/deployment check, frontend tests/typecheck/viewer build, Python tests, Swift tests/self-tests, Shortcut action audit/signature/archive check, `git diff --check`, and a secret/image artifact scan.
- [ ] **Step 2: Run the full verifier from a clean worktree and save only the command/result summary; require zero failures.**
- [ ] **Step 3: Apply migration `0008` to staging twice** and require the second run to report no pending migration. Deploy Worker support with version-4 advertisement off.
- [ ] **Step 4: Install the updated Mac helper/service and verify** active-ID fetch, one synthetic package completion, exact-once replay, package deletion, redacted logs, and the once-per-minute schedule.
- [ ] **Step 5: Deploy the viewer and enable version 4 for David only.** Install/replace the canonical Shortcut and remove old numbered copies after installation succeeds.
- [ ] **Step 6: Complete David's physical matrix:** camera, library, single-page, multi-page, faded/crumpled, photographed screen, cancellation, both model outputs/durations, Mac awake, Mac asleep then wake, browser close/reopen, one unavailable route, blank OCR fallback, network loss, no duplicate, and package deletion.
- [ ] **Step 7: Enable version 4 for Ariela and repeat the member-isolation, shared-folder, camera/library, Mac-off, model comparison, and completed-import checks on her iPhone.**
- [ ] **Step 8: Confirm one user-reviewed real receipt end to end**, including line items, summary arithmetic, comparison selection, draft creation, and no automatic transaction match.
- [ ] **Step 9: Enable production advertisement for both members.** Keep legacy upload support through the seven-day drain window; then remove old Shortcut copies, not the compatibility code, in this change.
- [ ] **Step 10: Record the matrix outcome and commit `docs: record iCloud receipt handoff acceptance`.**

## Final integration gate

- [ ] Run `scripts/verify-receipt-hybrid.sh` from a clean worktree.
- [ ] Run `git status --short`, `git diff --check`, and the repository secret/image scan.
- [ ] Request code and security review focused on package parsing, Access boundaries, member isolation, replay, cleanup, and logs.
- [ ] Create the PR only after automated gates pass; merge/deploy only after both physical-phone matrices pass.
- [ ] Do not write `done`, `fixed`, or `working on iPhone` in the handoff until the production URL and canonical Shortcut pass the recorded live receipt test.
