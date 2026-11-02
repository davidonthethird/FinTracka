# Apple Vision Receipt Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace crash-prone iPhone browser OCR with a free Apple Vision Shortcut that returns to one populated, reviewable FinTracka receipt draft without uploading receipt photos.

**Architecture:** An Access-authenticated FinTracka page issues a ten-minute, one-use scan token. A generic iPhone Shortcut performs native OCR locally and uploads only ordered recognized text to one exact public Worker path protected by that application token; the authenticated browser then claims the member-scoped temporary import, runs the existing parser, creates the normal draft idempotently, and deletes the import.

**Tech Stack:** React 19, TypeScript, Apple Shortcuts/Apple Vision `Extract Text from Image`, Cloudflare Worker/Access/D1, Zod, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-11-02-apple-vision-receipt-shortcut-design.md`

## Global Constraints

- Receipt photographs never leave the iPhone in this phase; only recognized text may be uploaded.
- No paid OCR, hosted LLM, image storage, or new recurring service is introduced.
- No permanent FinTracka or Cloudflare credential is stored in the Shortcut.
- The upload token is random 256-bit material, stored server-side only as SHA-256, expires after 10 minutes, and is consumed once.
- Cloudflare Access exposes only the exact path `/api/v1/mobile/shortcut/receipt-imports`; the Worker rejects every method except `POST`.
- Imports are scoped to their creating household member and expire after 30 minutes.
- Limits: 12 pages, 30,000 Unicode characters per page, 100,000 total characters, 128 KiB encoded request.
- All money remains integer minor units and all ledger changes continue through the existing explicit match and Mac validation flow.
- A failed or unusable scan must create zero receipt drafts.
- The production iPhone UI must not invoke PaddleOCR/WebAssembly.

## Review Focus

- Safari returning from Shortcuts after its Access session expired must resume the same opaque import after login, without exposing text or creating a duplicate.
- A repeated Shortcut upload after a network timeout must replay the same import only when token, idempotency key, and canonical body digest all match before session expiry; any changed reuse is rejected.
- Mixed CRLF, nonbreaking spaces, blank lines, and text/price lines separated by Apple Vision must normalize without merging unrelated prices.
- Another household member must not retrieve or finalize the first member's import.
- Expired sessions/imports and failed parsing must create no empty draft and must present a recoverable retry/discard path.

---

### Task 1: Add bounded one-time scan sessions and temporary OCR imports

**Files:**
- Create: `remote/migrations/0005_receipt_shortcut_imports.sql`
- Create: `remote/src/receiptShortcutModel.ts`
- Create: `remote/src/receiptShortcutStore.ts`
- Create: `remote/tests/receipt-shortcut-store.test.ts`
- Modify: `remote/src/mobileCommandStore.ts`

**Interfaces:**
- Produces: `ReceiptShortcutCaptureSchema`, `ReceiptShortcutCapture`, `PublicReceiptImport`
- Produces: `ReceiptShortcutStore.createSession(householdId, memberId): Promise<ScanSession>`
- Produces: `ReceiptShortcutStore.createImport(token, capture): Promise<{ import: PublicReceiptImport; replayed: boolean }>`
- Produces: `ReceiptShortcutStore.getImport(householdId, memberId, id): Promise<PublicReceiptImport>`
- Produces: `ReceiptShortcutStore.deleteImport(householdId, memberId, id): Promise<void>`
- Produces: `MobileCommandStore.resolveMemberById(id): Promise<HouseholdMember | null>`

- [ ] **Step 1: Write failing store tests**

Cover a 10-minute session, SHA-256-only token storage, atomic first use, identical token/key/body replay, changed-key/body replay rejection, expired token rejection, 30-minute import expiry, member isolation, active-member validation, 10 sessions/member/hour, 5 active imports/member, opportunistic cleanup, and the exact page/text/body bounds from Global Constraints.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `cd remote && npm test -- tests/receipt-shortcut-store.test.ts`

Expected: FAIL because the migration, schemas, and store do not exist.

- [ ] **Step 3: Add the D1 migration**

Create `receipt_scan_sessions` with `token_digest` as the key plus household/member/expiry timestamps and nullable `consumed_import_id`, `idempotency_key`, and `body_digest`, and `receipt_shortcut_imports` with opaque ID, household/member, canonical page JSON, idempotency key, and expiry. Add member/expiry indexes and foreign keys to the existing household tables. Never persist the plaintext token.

- [ ] **Step 4: Implement strict capture schemas**

In `receiptShortcutModel.ts`, define the exact `receipt_shortcut_capture/v1` contract and bounded page schema. Reject unknown keys, blank normalized text, duplicate/out-of-order `page_index`, invalid UUID idempotency values, and every Global Constraints limit.

- [ ] **Step 5: Implement the store and member lookup**

Generate 32 random bytes with Web Crypto, return base64url plaintext once, store only its digest, use D1 conditional writes/batches to consume it when the import is created, and make only the same token/key/canonical-body digest replay return the original import until expiry. Add `resolveMemberById` using the same active household checks as email lookup.

- [ ] **Step 6: Run focused tests**

Run: `cd remote && npm test -- tests/receipt-shortcut-store.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add remote/migrations/0005_receipt_shortcut_imports.sql remote/src/receiptShortcutModel.ts remote/src/receiptShortcutStore.ts remote/src/mobileCommandStore.ts remote/tests/receipt-shortcut-store.test.ts
git commit -m "feat: add one-time receipt shortcut imports"
```

### Task 2: Add the public one-time upload and authenticated import APIs

**Files:**
- Create: `remote/src/receiptShortcutGateway.ts`
- Create: `remote/tests/receipt-shortcut-gateway.test.ts`
- Modify: `remote/src/mobileGateway.ts`
- Modify: `remote/src/viewer.ts`
- Modify: `remote/wrangler.viewer.jsonc`

**Interfaces:**
- Consumes: Task 1 store/model interfaces
- Produces: `POST /api/v1/mobile/receipt-scan-sessions`
- Produces: `POST /api/v1/mobile/shortcut/receipt-imports`
- Produces: `GET|DELETE /api/v1/mobile/receipt-imports/{id}`
- Produces: session response `{ contract, token, upload_url, expires_at }`
- Produces: upload response `{ import_id, review_url }`

- [ ] **Step 1: Write failing gateway tests**

Test browser session issuance through an Access member with same-origin and `Sec-Fetch-Site` validation; upload without Access JWT but with the bearer token; exact `POST` method and JSON type; missing, malformed, expired, identical-replay, and changed-replay tokens; strict request/body limits; safe errors that never echo tokens/text; no CORS; same-member GET/DELETE; cross-member denial; and feature-disabled 404 behavior.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `cd remote && npm test -- tests/receipt-shortcut-gateway.test.ts`

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Implement upload authentication before browser Access resolution**

Route only the exact `/api/v1/mobile/shortcut/receipt-imports` path to `receiptShortcutGateway` before `resolveBrowserIdentity`. Accept only `POST`, `application/json`, and `Authorization: Bearer`; never enable CORS. All other `/api/v1/mobile/*` paths retain their current Access identity flow.

- [ ] **Step 4: Implement browser session and import routes**

Issue sessions only for the already resolved active member after applying the existing browser JSON origin checks, no CORS, and the concrete 10/hour session limit. Retrieve/delete imports only when household and member both match. Construct `upload_url` and `review_url` from the validated request origin, never from forwarded arbitrary host values.

- [ ] **Step 5: Add an explicit feature flag**

Add `FEATURE_RECEIPT_SHORTCUT` to `MobileGatewayEnv` and staging/production configuration with a default-off check in code. Enable it in committed environment vars only when the corresponding Access exact-path gate is ready; tests must prove default-off behavior.

- [ ] **Step 6: Run focused and existing remote tests**

Run: `cd remote && npm test -- tests/receipt-shortcut-gateway.test.ts tests/mobile-gateway.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add remote/src/receiptShortcutGateway.ts remote/src/mobileGateway.ts remote/src/viewer.ts remote/wrangler.viewer.jsonc remote/tests/receipt-shortcut-gateway.test.ts
git commit -m "feat: add secure shortcut receipt handoff"
```

### Task 3: Adapt Apple Vision text to the existing receipt parser

**Files:**
- Create: `frontend/src/viewer/receipts/receiptPlainText.ts`
- Create: `frontend/src/viewer/receipts/receiptDraftBuilder.ts`
- Create: `frontend/tests/receipt-plain-text.test.ts`
- Modify: `frontend/src/viewer/receipts/ReceiptCapturePage.tsx`
- Modify: `frontend/tests/receipt-parser.test.ts`

**Interfaces:**
- Produces: `receiptPagesFromPlainText(pages: ShortcutTextPage[]): OcrReceiptPage[]`
- Produces: `draftFromParsedReceipt(parsed: ParsedReceiptCandidate, pageCount: number): ReceiptDraftV1`
- Consumes: existing `parseReceiptPages` and `reconcileReceipt`

- [ ] **Step 1: Write failing adapter and builder tests**

Test CRLF/NBSP normalization, stable page/line order, blank-line removal, a text line followed by a money-only line sharing one synthetic visual row, consecutive unrelated money lines staying separate, conservative confidence/review flags, duplicate page text, totals/arithmetic, and zero-field parsing returning unusable rather than manufacturing a draft.

- [ ] **Step 2: Add sanitized Apple-style text fixtures derived from the private receipt set**

Extend parser tests with Target, ACME, Lowe's, Stop & Shop, and Home Depot recognized-text shapes. Assert visible merchant/summary values and priced lines; never commit the private photos or personally identifying receipt text.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `cd frontend && npm test -- receipt-plain-text receipt-parser`

Expected: FAIL because the adapter and shared builder do not exist.

- [ ] **Step 4: Implement the plain-text adapter**

Create synthetic observations only from recognized lines. Place an immediately following money-only line in the prior text row with a right-column bounding box; otherwise assign sequential rows. Use conservative confidence so review remains visible. Do not correct spelling, infer missing amounts, or add merchant knowledge outside the existing parser.

- [ ] **Step 5: Extract the existing draft builder**

Move `fromParsed` from `ReceiptCapturePage.tsx` to `receiptDraftBuilder.ts` without changing reconciliation semantics. Update the browser benchmark path to call the shared function so both OCR sources produce the same `receipt_draft/v1` shape.

- [ ] **Step 6: Run focused tests**

Run: `cd frontend && npm test -- receipt-plain-text receipt-parser receipt-pages`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/viewer/receipts/receiptPlainText.ts frontend/src/viewer/receipts/receiptDraftBuilder.ts frontend/src/viewer/receipts/ReceiptCapturePage.tsx frontend/tests/receipt-plain-text.test.ts frontend/tests/receipt-parser.test.ts
git commit -m "feat: parse Apple Vision receipt text"
```

### Task 4: Launch the Shortcut and finalize the returned import

**Files:**
- Create: `frontend/src/viewer/receipts/receiptShortcutApi.ts`
- Create: `frontend/src/viewer/receipts/ReceiptShortcutImportPage.tsx`
- Create: `frontend/tests/receipt-shortcut-pages.test.tsx`
- Modify: `frontend/src/viewer/receipts/ReceiptCapturePage.tsx`
- Modify: `frontend/src/viewer/ViewerApp.tsx`
- Modify: `frontend/src/viewer/viewer.css`
- Modify: `frontend/e2e/remote-viewer.spec.ts`

**Interfaces:**
- Consumes: Task 2 HTTP APIs and Task 3 adapter/builder
- Produces: `createReceiptScanSession(): Promise<ReceiptScanSession>`
- Produces: `getReceiptImport(id): Promise<PublicReceiptImport>`
- Produces: `deleteReceiptImport(id): Promise<void>`
- Produces: `buildReceiptShortcutUrl(session): string`
- Produces: route `/receipts/import/{opaque-id}`

- [ ] **Step 1: Write failing component tests**

Test pure helpers for preloaded session state, a URL-encoded `shortcuts://run-shortcut` link named `FinTracka Scan Receipt`, no HTTPS query-string token, usable-vs-unusable parsing, deterministic idempotency, and cleanup ordering. Cover confirmation, focus, taps, retry/discard states, and navigation behavior in the existing Playwright suite instead of adding a DOM test dependency.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd frontend && npm test -- receipt-shortcut-pages receipt-pages viewer-navigation`

Expected: FAIL because the API, page, and route do not exist.

- [ ] **Step 3: Implement session preload and launch UI**

On `/receipts/new`, request one session into component memory and render **Scan with iPhone** only when ready. Explain the brief Shortcut handoff and that photos stay on the phone. Remove production iPhone file inputs and PaddleOCR invocation; keep the OCR benchmark reachable only from its private development route. Do not add an empty manual-draft path in this change.

- [ ] **Step 4: Implement import finalization**

Fetch the member-scoped import, adapt and parse it, reject unusable output without creating a draft, and call `createReceipt(draft, "shortcut-import-" + import.id)` for deterministic replay. After creation, await import deletion inside `try/catch`, then navigate to `/receipts/{draft.id}` regardless of deletion failure. A retry must replay the same draft and retry cleanup.

- [ ] **Step 5: Add mobile layout and accessibility**

Keep the capture/import pages within the five-tab safe area, use a real link for the custom scheme, announce preparation/import progress, focus errors, and provide 44-pixel touch targets.

- [ ] **Step 6: Add Playwright coverage**

Mock the session/import APIs and assert the custom-scheme URL, populated review navigation, unusable-text failure, expired-import recovery, and absence of a browser OCR asset request in the production flow.

- [ ] **Step 7: Run focused frontend verification**

Run: `cd frontend && npm test -- receipt-shortcut-pages receipt-pages viewer-navigation && npm run typecheck:viewer && npm run build:viewer`

Expected: PASS; the Viewer build does not load OCR modules on the receipt capture route.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/viewer/receipts/receiptShortcutApi.ts frontend/src/viewer/receipts/ReceiptShortcutImportPage.tsx frontend/src/viewer/receipts/ReceiptCapturePage.tsx frontend/src/viewer/ViewerApp.tsx frontend/src/viewer/viewer.css frontend/tests/receipt-shortcut-pages.test.tsx frontend/e2e/remote-viewer.spec.ts
git commit -m "feat: add iPhone receipt shortcut flow"
```

### Task 5: Add safe Receipt Inbox removal

**Files:**
- Modify: `frontend/src/viewer/receipts/ReceiptInboxPage.tsx`
- Modify: `frontend/src/viewer/receipts/ReceiptProvider.tsx`
- Modify: `frontend/src/viewer/viewer.css`
- Modify: `frontend/tests/receipt-pages.test.tsx`

**Interfaces:**
- Consumes: existing `ReceiptProvider.dismiss(current)` and optimistic-revision API
- Produces: accessible per-row dismiss action for eligible statuses

- [ ] **Step 1: Write failing eligibility and markup tests**

Add and test `canDismissReceipt(status)` for `editing`, `waiting_for_bank`, and `conflict`, with false for `match_pending`, `processing`, and `matched`. Use the existing static-markup test to assert separate open/remove controls and no nested interactive controls. Cover confirmation, click behavior, and conflict refresh in the existing Playwright suite.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd frontend && npm test -- receipt-pages`

Expected: FAIL because inbox rows have no remove action.

- [ ] **Step 3: Implement row and removal behavior**

Replace the all-row button with a non-nested row layout containing separate open and remove buttons. Confirm with clear receipt identification, disable while dismissing, call the existing provider method, and surface safe errors without removing the row optimistically.

- [ ] **Step 4: Run tests and accessibility-oriented markup checks**

Run: `cd frontend && npm test -- receipt-pages receipt-shortcut-pages && npm run typecheck:viewer`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/viewer/receipts/ReceiptInboxPage.tsx frontend/src/viewer/receipts/ReceiptProvider.tsx frontend/src/viewer/viewer.css frontend/tests/receipt-pages.test.tsx
git commit -m "feat: dismiss receipt drafts from inbox"
```

### Task 6: Build the generic iPhone Shortcut and deployment runbook

**Files:**
- Create: `docs/receipt-shortcut-setup.md`
- Modify: `docs/receipt-processing-runbook.md`
- Modify: `README.md`
- Modify: `REMOTE_VIEWER_RUNBOOK.md`

**Interfaces:**
- Consumes: Task 2 session/upload contracts and Task 4 launch URL
- Produces: installed `FinTracka Scan Receipt` Shortcut with no embedded environment credential
- Produces: exact Cloudflare Access path configuration and rollback procedure

- [ ] **Step 1: Document the exact Shortcut actions**

Record action names and variables for: reading JSON Shortcut Input; validating contract/expiry and required Shortcut version; camera-vs-library menu; page count; `Extract Text from Image`; blank-text guard; ordered page dictionaries; UUID idempotency key; `Get Contents of URL` JSON POST with bearer header; response validation; `Open URLs`; and local error messaging. Include screenshots after the real Shortcut is built, redacting tokens and receipt text.

- [ ] **Step 2: Build and inspect the Shortcut on the test iPhone**

Verify it contains no hard-coded upload URL, Access client ID/secret, bearer token, receipt text, or analytics action. Confirm Photos and Camera permissions appear only when used. Install the same reviewed version on David's and Ariela's phones and document replacement of an older version plus recovery when the custom scheme cannot find the Shortcut.

- [ ] **Step 3: Configure staging Access with the exact public path override**

Add a most-specific public path override for exactly `/api/v1/mobile/shortcut/receipt-imports`; Access does not filter methods, so confirm the Worker rejects every non-`POST` method. Confirm neighboring paths still return the Access login/denial. Record application IDs and policy screenshots outside source control if they contain account details.

- [ ] **Step 4: Deploy and run the security matrix in staging**

Verify: no token, wrong token, expired token, replay, wrong method, oversized body, neighboring path, cross-member import, and safe error bodies. Then verify one valid camera scan and one library scan return to the correct populated review page.

- [ ] **Step 5: Update operating and rollback documentation**

Document enabling/disabling `FEATURE_RECEIPT_SHORTCUT`, removing only the exact public path override, revoking outstanding sessions by deleting their rows, and returning the UI to the existing receipt inbox without affecting drafts or matching.

- [ ] **Step 6: Commit**

```bash
git add docs/receipt-shortcut-setup.md docs/receipt-processing-runbook.md README.md REMOTE_VIEWER_RUNBOOK.md
git commit -m "docs: add receipt shortcut deployment runbook"
```

### Task 7: Complete real-device acceptance and production release

**Files:**
- Modify: `docs/receipt-processing-runbook.md`
- Modify if defects are found: only the files owned by Tasks 1–6

**Interfaces:**
- Consumes: complete staging implementation and the user's private receipt images
- Produces: recorded acceptance evidence and a reversible production release

- [ ] **Step 1: Run full automated verification**

Run:

```bash
cd remote && npm ci && npm run test:ci && npm run typecheck
cd ../frontend && npm ci && npm test && npm run typecheck:viewer && npm run build:viewer && npm run test:e2e
cd .. && pytest -q
```

Expected: all commands PASS.

- [ ] **Step 2: Run the private receipt acceptance set on a real iPhone**

Test all supplied Target, ACME, Lowe's, Stop & Shop, Home Depot, and additional photos from both Camera and Photos where applicable. Record the exact expected merchant, each visible summary amount, every visible priced line, duplicate handling, processing duration, correction count, and whether any page reload/crash occurred. Require exact benchmark evidence, zero Safari OCR crashes, and zero empty drafts; do not ship if deterministic text-order parsing regresses any supplied receipt.

- [ ] **Step 3: Test lifecycle and recovery**

Test cancel, offline upload then retry, expired scan session, Access login expiration before return, identical duplicate upload replay, changed replay rejection, parser rejection, import discard, inbox dismissal, custom-scheme/Shortcut-not-installed recovery, and a successful existing transaction match through the Mac exact-once flow. In airplane mode with a locally stored photo, also verify `Extract Text from Image` finishes before the expected upload failure.

- [ ] **Step 4: Record the staging gate**

Add the dated results to `docs/receipt-processing-runbook.md`. Do not enable production when any security isolation, duplicate, empty-draft, or exact-cent test fails; OCR uncertainty that is visibly flagged and manually correctable may be documented rather than hidden.

- [ ] **Step 5: Configure the exact production Access path and deploy**

Mirror only the reviewed staging public path override, enable the production feature flag, deploy the Worker and Viewer, and immediately repeat one camera scan, one library scan, replay rejection, neighboring-path denial, and cross-member isolation.

- [ ] **Step 6: Create the PR and merge only after production smoke tests**

```bash
git add docs/receipt-processing-runbook.md
git commit -m "test: record Apple Vision receipt acceptance"
git push -u origin HEAD
gh pr create --fill
```

- [ ] **Step 7: Schedule a separate cleanup after proven use**

After the Shortcut has remained successful on real receipts, remove the unused production PaddleOCR dependencies/assets and browser capture implementation in a small follow-up PR. Do not mix that rollback-removing cleanup into the initial release.

## Self-review result

- Spec coverage: session security, Shortcut capture, text adaptation, idempotent finalization, failure behavior, draft removal, staging, private-receipt testing, and production rollback are each owned by a task.
- Type consistency: the plan uses one `ReceiptShortcutCapture`, one `PublicReceiptImport`, and deterministic `shortcut-import-{id}` idempotency across Worker and frontend.
- Proportion: implementation details are limited to contracts, interfaces, security bounds, and tests that cannot be safely guessed by an implementer.
- Deferred deliberately: native iOS packaging, image upload, cloud OCR, and removal of rollback code before real-device acceptance.
