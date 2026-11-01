# Mobile Receipt Scanning and Item-Level Splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add free, private mobile receipt capture/OCR, collaborative unmatched drafts, exact A/D/S item allocation, explicit bank-transaction matching, and exact-once Mac application to canonical transaction splits.

**Architecture:** Phase A keeps page images on the iPhone, runs self-hosted OCR in the Viewer, and stores only versioned structured receipt drafts in D1. Phase B adds snapshot v3 split revisions and a typed `transaction.apply_receipt_split/v1` command; the Mac fetches the immutable referenced draft revision and atomically writes local receipt records and detailed transaction splits. Phase C in this plan improves extraction and correction but deliberately excludes cloud image persistence until encrypted off-device recovery exists.

**Tech Stack:** React 19, TypeScript 7/5.9, Vite 8, Vitest 5, Playwright 1.64, Tesseract.js 7.0.0/WebAssembly, IndexedDB, Cloudflare Workers/D1/R2/Access, Python 3.11+, FastAPI, SQLite.

**Spec:** `docs/superpowers/specs/2026-10-31-mobile-receipt-scanning-design.md`

## Global Constraints

- Mac SQLite remains authoritative for committed financial records; D1 receipt drafts remain non-financial collaboration data.
- Original receipt images stay in origin-private browser storage and never upload in this release.
- OCR worker/core/language assets are self-hosted; no runtime CDN, paid OCR/LLM, analytics, or third-party image/text request is allowed.
- Use integer minor units for money and deterministic largest-remainder allocation; every applied split must sum exactly to its parent transaction.
- Initial bounds are 12 pages, 250 lines, 256 KiB per structured revision, 20 active drafts per household, and 30 draft writes per member per hour.
- Both household members can collaborate; item-owner colors remain David blue, Ariela pink, Shared dark purple.
- Receipt draft, snapshot, and financial command contracts are independently versioned and strictly reject unknown fields.
- Tests, fixtures, logs, screenshots, and source use synthetic receipt/transaction data only.
- No archive/delete, account/Plaid, taxonomy-admin, or arbitrary ledger-write authority is added to mobile APIs.
- Do not add cloud image persistence until verified encrypted off-device recovery has a separately approved design.
- Do not touch unrelated repository work or any Cold Turkey/security self-control files.

## Review Focus

- Overlapping long-receipt pages: uncertain duplicate lines remain visible and cannot be silently removed; Task 3 pins this with parser fixtures.
- Tax/discount/tip rounding: positive, zero-basis, exempt-item, and remainder-tie inputs reconcile exactly; Task 1 pins these cases.
- Lost responses and concurrent household edits: idempotent create/save and stale revisions cannot duplicate or overwrite draft lines; Task 2 pins both races.
- Pending-to-posted or locally split targets: canonical identity is preserved where safe, while stale split revisions conflict without mutation; Tasks 7 and 9 pin this.
- Completion failure/replay: a locally committed receipt cannot create duplicate receipt rows or splits, and split owners must flow into reports; Tasks 6 and 9 pin this.

---

## File Structure

### Browser receipt domain

- `frontend/src/viewer/receipts/types.ts` — versioned client receipt types and limits.
- `frontend/src/viewer/receipts/receiptMath.ts` — integer-cent reconciliation and largest-remainder allocation.
- `frontend/src/viewer/receipts/receiptOcr.ts` — OCR-engine boundary and Tesseract adapter.
- `frontend/src/viewer/receipts/receiptParser.ts` — normalized observations, field candidates, and overlap groups.
- `frontend/src/viewer/receipts/receiptImages.ts` — IndexedDB page blobs, preprocessing, retention, and quota state.
- `frontend/src/viewer/receipts/receiptApi.ts` — typed receipt API and candidate scoring.
- `frontend/src/viewer/receipts/ReceiptProvider.tsx` — session capability, draft/command state, focus refresh, and errors.
- `frontend/src/viewer/receipts/ReceiptInboxPage.tsx` — draft/status list.
- `frontend/src/viewer/receipts/ReceiptCapturePage.tsx` — local page capture and OCR progress.
- `frontend/src/viewer/receipts/ReceiptReviewPage.tsx` — line correction, A/D/S, categories, and reconciliation.
- `frontend/src/viewer/receipts/ReceiptMatchPage.tsx` — explainable candidate selection and command status.
- `frontend/scripts/copy-receipt-ocr-assets.mjs` — self-host pinned worker/core/language data into the Viewer build.

### Cloud collaboration and commands

- `remote/migrations/0003_receipt_drafts.sql` — receipt drafts, current lines, immutable revisions, events, quotas/indexes.
- `remote/migrations/0004_receipt_commands.sql` — widen typed command/check constraints for receipt split commands.
- `remote/src/receiptModel.ts` — strict v1 draft/revision/API schemas and canonical digest.
- `remote/src/receiptStore.ts` — household-scoped optimistic draft persistence and immutable revisions.
- `remote/src/receiptGateway.ts` — browser/Mac receipt routes and limits.
- `remote/src/mobileCommandModel.ts` / `mobileCommandStore.ts` — typed command union and receipt result lifecycle.
- `remote/src/mobileGateway.ts` — route delegation, capabilities, snapshot revalidation, and match submission.

### Authoritative Mac ledger

- `src/fintracka/migrations/021_receipt_splits.sql` — split revision, detailed split columns, local receipts/lines/application audit.
- `src/fintracka/receipts.py` — receipt document validation, exact apply/correction, and audit/undo domain.
- `src/fintracka/ledger.py` — backward-compatible manual split wrapper over detailed splits.
- `src/fintracka/mobile_command_client.py` — command union plus immutable receipt-revision fetch.
- `src/fintracka/mobile_command_service.py` — receipt command dispatch, validation, atomic application, and safe result.
- `src/fintracka/remote_models.py` / `remote_snapshot.py` — snapshot v3, split revisions, and receipt matching capability.
- `src/fintracka/reports.py`, `planning.py`, `exports.py`, `financial_mutations.py` — detailed split owner/category/subcategory semantics.

---

## Phase A — Capture, OCR, Review, and Unmatched Drafts

### Task 1: Exact-Cent Receipt Domain and OCR Feasibility Gate

**Files:**
- Create: `frontend/src/viewer/receipts/types.ts`
- Create: `frontend/src/viewer/receipts/receiptMath.ts`
- Create: `frontend/src/viewer/receipts/receiptOcr.ts`
- Create: `frontend/scripts/copy-receipt-ocr-assets.mjs`
- Create: `frontend/tests/receipt-math.test.ts`
- Create: `frontend/tests/receipt-ocr-assets.test.ts`
- Create: `frontend/e2e/fixtures/receipts/` with synthetic one-page and overlapping-page images
- Modify: `frontend/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `allocateMinor(totalMinor: number, bases: AllocationBasis[]) => AllocationResult[]`.
- Produces: `reconcileReceipt(input: ReceiptReconciliationInput) => ReceiptReconciliation`.
- Produces: `ReceiptOcrEngine.recognize(pages: PreparedReceiptPage[], signal: AbortSignal) => Promise<OcrReceiptPage[]>`.
- Produces: pinned local asset URLs exported by `receiptOcr.ts`.

- [ ] **Step 1: Write failing receipt-math tests**

Cover proportional tax over taxable post-discount lines, tax-exempt exclusion, receipt-level discount, tip/fee distribution, stable one-cent ties, negative/zero basis rejection, integer-only validation, and `items - discounts + tax + tip + fees === total`.

- [ ] **Step 2: Run the receipt-math tests and verify RED**

Run: `npm --prefix frontend test -- --run tests/receipt-math.test.ts`
Expected: FAIL because `receiptMath.ts` does not exist.

- [ ] **Step 3: Implement the minimal typed math domain**

Use integer arithmetic and stable line order. Return explicit per-line allocations and a signed `difference_minor`; never hide an unallocated cent.

- [ ] **Step 4: Add pinned OCR dependencies and self-hosting tests**

Pin `tesseract.js@7.0.0` and `@tesseract.js-data/eng@1.0.0`. The copy script must fail if expected package assets are missing and must not contain or emit `http://`, `https://`, or CDN fallbacks. Tests assert that the built Viewer references same-origin worker/core/language URLs.

- [ ] **Step 5: Implement the OCR adapter and synthetic benchmark screen**

The adapter creates one reusable worker, exposes progress, handles cancellation, processes multiple pages sequentially, and terminates cleanly. Add a development-only benchmark route/component using synthetic images without writing drafts.

- [ ] **Step 6: Verify automated and real-device feasibility**

Run:

```bash
npm --prefix frontend test -- --run tests/receipt-math.test.ts tests/receipt-ocr-assets.test.ts
npm --prefix frontend run typecheck:viewer
npm --prefix frontend run build:viewer
```

Then test on the household iPhone: one page completes within 15 seconds and six pages within 90 seconds without Safari reloading. Record device/iOS, image dimensions, duration, peak observed behavior, and selected working resolution in `docs/receipt-ocr-feasibility.md`. If the gate fails after one bounded-resolution adjustment, stop before Task 2 and revisit the approved approach.

- [ ] **Step 7: Commit Task 1**

```bash
git add frontend/package.json package-lock.json frontend/scripts frontend/src/viewer/receipts frontend/tests/receipt-math.test.ts frontend/tests/receipt-ocr-assets.test.ts frontend/e2e/fixtures/receipts docs/receipt-ocr-feasibility.md
git commit -m "feat: establish private receipt OCR and cent math"
```

### Task 2: Cloud Receipt Draft Contract, Storage, and API

**Files:**
- Create: `remote/migrations/0003_receipt_drafts.sql`
- Create: `remote/src/receiptModel.ts`
- Create: `remote/src/receiptStore.ts`
- Create: `remote/src/receiptGateway.ts`
- Create: `remote/tests/receipt-model.test.ts`
- Create: `remote/tests/receipt-store.test.ts`
- Create: `remote/tests/receipt-gateway.test.ts`
- Modify: `remote/src/mobileGateway.ts`
- Modify: `remote/wrangler.viewer.jsonc`
- Modify: `remote/scripts/check-mobile-command-deployment.ts`

**Interfaces:**
- Consumes: limits and canonical `ReceiptDraftV1` field names from Task 1.
- Produces: `ReceiptDraftV1Schema`, `ReceiptRevisionV1Schema`, and `canonicalReceiptRevision(value) => string`.
- Produces: `ReceiptStore.create`, `list`, `get`, `replace`, `dismiss`, `getImmutableRevision`, and `expireAndPrune`.
- Produces: browser routes under `/api/v1/mobile/receipts` and Mac-only immutable revision fetch.

- [ ] **Step 1: Write failing model/store tests**

Assert strict unknown-field rejection, integer monetary fields, valid A/D/S owner, category/subcategory shape, 12-page/250-line/256-KiB bounds, canonical digest stability, immutable revision insertion, exact idempotent replay, stale `expected_revision` conflict, cross-household denial, active-draft limit, write-rate limit, 90-day retention, and safe event details.

- [ ] **Step 2: Run the receipt storage tests and verify RED**

Run: `npm --prefix remote run test:ci -- tests/receipt-model.test.ts tests/receipt-store.test.ts`
Expected: FAIL because the migration/model/store do not exist.

- [ ] **Step 3: Implement migration, strict model, and transactional store**

Create current draft/line tables plus immutable `receipt_revisions` keyed by `(draft_id, revision)`. A successful replace writes current rows, one canonical immutable revision/digest, and one safe event in a single D1 batch. Store no images or full card numbers.

- [ ] **Step 4: Write failing gateway/auth tests**

Cover authenticated household CRUD, same-origin enforcement, missing/inactive member, oversized body before parsing, image/blob field rejection, browser denial of Mac route, Mac service denial of browser routes, no permissive CORS, and `FEATURE_RECEIPT_DRAFTS=false` returning `404`/empty capability.

- [ ] **Step 5: Implement route delegation and disabled-by-default capability**

Add `FEATURE_RECEIPT_DRAFTS` to staging/production configuration with value `false`. `GET /api/v1/mobile/session` advertises `receipts.drafts: [1]` only when enabled. Keep financial matching absent.

- [ ] **Step 6: Verify Task 2**

Run:

```bash
npm --prefix remote run test:ci -- tests/receipt-model.test.ts tests/receipt-store.test.ts tests/receipt-gateway.test.ts
npm --prefix remote run typecheck
```

Expected: all pass, and migrations apply twice without changing retained synthetic draft/revision/event rows.

- [ ] **Step 7: Commit Task 2**

```bash
git add remote/migrations/0003_receipt_drafts.sql remote/src/receiptModel.ts remote/src/receiptStore.ts remote/src/receiptGateway.ts remote/src/mobileGateway.ts remote/tests remote/wrangler.viewer.jsonc remote/scripts/check-mobile-command-deployment.ts
git commit -m "feat: add versioned cloud receipt drafts"
```

### Task 3: Local Image Store, Receipt Parser, and Overlap Review

**Files:**
- Create: `frontend/src/viewer/receipts/receiptImages.ts`
- Create: `frontend/src/viewer/receipts/receiptParser.ts`
- Create: `frontend/tests/receipt-images.test.ts`
- Create: `frontend/tests/receipt-parser.test.ts`

**Interfaces:**
- Consumes: `ReceiptOcrEngine` and receipt types from Task 1.
- Produces: `ReceiptImageStore.put/get/list/deleteDraft/prune`, `prepareReceiptPage`, and storage-status methods.
- Produces: `parseReceiptPages(pages: OcrReceiptPage[]) => ParsedReceiptCandidate` with overlap groups and confidence basis points.

- [ ] **Step 1: Write failing IndexedDB/storage tests**

Use a fake IndexedDB test adapter. Assert opaque keys, no localStorage use, page ordering, rotate/crop metadata, quota failure as a typed recoverable state, immediate draft deletion, 30-day pruning, and survival of structured data when blobs are absent.

- [ ] **Step 2: Implement the image store and preprocessing boundary**

Use origin-private IndexedDB blobs and ImageBitmap/Canvas adapters. Bound page dimensions/encoded size using the Task 1 benchmark result, revoke object URLs, and never serialize image bytes into API payloads.

- [ ] **Step 3: Write failing parser and overlap tests**

Synthetic observations cover merchant/date/subtotal/tax/total extraction, quantities and discounts, confidence propagation, adjacent-page exact overlap collapse, uncertain similar-line grouping, repeated legitimate identical items, and no silent deletion when bounding/order evidence is ambiguous.

- [ ] **Step 4: Implement deterministic parsing and overlap grouping**

Keep raw normalized observations separate from reviewed lines. Exact collapse requires normalized text, compatible amount, adjacent pages, and boundary position evidence; every other possible duplicate becomes an explicit review group.

- [ ] **Step 5: Verify and commit Task 3**

Run:

```bash
npm --prefix frontend test -- --run tests/receipt-images.test.ts tests/receipt-parser.test.ts
npm --prefix frontend run typecheck:viewer
```

Commit:

```bash
git add frontend/src/viewer/receipts/receiptImages.ts frontend/src/viewer/receipts/receiptParser.ts frontend/tests/receipt-images.test.ts frontend/tests/receipt-parser.test.ts
git commit -m "feat: parse and retain local receipt pages"
```

### Task 4: Receipt Capture, Review, and Inbox UI

**Files:**
- Create: `frontend/src/viewer/receipts/receiptApi.ts`
- Create: `frontend/src/viewer/receipts/ReceiptProvider.tsx`
- Create: `frontend/src/viewer/receipts/ReceiptInboxPage.tsx`
- Create: `frontend/src/viewer/receipts/ReceiptCapturePage.tsx`
- Create: `frontend/src/viewer/receipts/ReceiptReviewPage.tsx`
- Create: `frontend/tests/receipt-pages.test.tsx`
- Modify: `frontend/src/viewer/TransactionsPage.tsx`
- Modify: `frontend/src/viewer/ViewerApp.tsx`
- Modify: `frontend/src/viewer/viewer.css`

**Interfaces:**
- Consumes: Tasks 1–3 and the Task 2 API.
- Produces: `/receipts`, `/receipts/new`, and `/receipts/{id}` Viewer routes.
- Produces: complete Phase A workflow ending in `waiting_for_bank` with no financial command.

- [ ] **Step 1: Write failing component/API tests**

Assert Scan receipt and Receipt Inbox entry points; camera/library input; 12-page enforcement; reorder/rotate/remove/retry; cancellable OCR progress; manual-only continuation; A/D/S controls/colors; multi-select assignment; category/subcategory parent enforcement; uncertainty/overlap review; sticky exact-difference footer; disabled final save with unassigned/mismatched lines; optimistic conflict UI; and the explicit “no spending added” message.

- [ ] **Step 2: Implement typed API client and receipt routes**

Use no-store same-origin requests and typed error codes. `ReceiptProvider` reads the authenticated session receipt capability and refreshes structured draft/command state on focus without polling images. Do not add a sixth bottom-navigation item.

- [ ] **Step 3: Implement capture and OCR UI**

Lazy-load the OCR adapter only on capture. Preserve the page list if one OCR page fails. Show that images remain on this device and local storage is best-effort.

- [ ] **Step 4: Implement review and inbox UI**

Use a mobile-first editable list, compact owner controls, category/subcategory picker, explicit calculated tax/fee allocations, and grouped status sections. Render all OCR text through normal React text nodes.

- [ ] **Step 5: Verify Phase A frontend**

Run:

```bash
npm --prefix frontend test -- --run receipt
npm --prefix frontend run typecheck:viewer
npm --prefix frontend run build:viewer
```

- [ ] **Step 6: Commit Task 4**

```bash
git add frontend/src/viewer/receipts frontend/src/viewer/TransactionsPage.tsx frontend/src/viewer/ViewerApp.tsx frontend/src/viewer/viewer.css frontend/tests
git commit -m "feat: add mobile receipt capture and review"
```

### Task 5: Phase A Staging, Security, and Production Gate

**Files:**
- Create: `frontend/e2e/receipt-drafts.spec.ts`
- Create: `docs/receipt-drafts-runbook.md`
- Modify: `REMOTE_VIEWER_RUNBOOK.md`
- Modify: `remote/wrangler.viewer.jsonc`

**Interfaces:**
- Consumes: Phase A Tasks 1–4.
- Produces: an independently usable unmatched-draft feature; no financial matching capability.

- [ ] **Step 1: Add E2E and security tests**

Cover one-page/manual and multi-page/OCR paths; two-member revision conflict; lost create/save response replay; offline Mac with successful draft save; no change to financial snapshot/aggregates; cross-household/direct API denial; XSS-like OCR descriptions rendered inert; CSP/no-third-party request assertion; retention cleanup; and browser image-loss recovery.

- [ ] **Step 2: Run full Phase A verification**

Run:

```bash
npm --prefix remote run test:ci
npm --prefix remote run typecheck
npm --prefix frontend test -- --run
npm --prefix frontend run typecheck:viewer
npm --prefix frontend run build:viewer
npm --prefix frontend run test:e2e -- receipt-drafts.spec.ts
npm audit --prefix frontend --omit=dev
npm audit --prefix remote --omit=dev
```

- [ ] **Step 3: Apply D1 migration and deploy disabled staging**

Apply `0003` to staging twice, deploy Publisher/Viewer, and verify no receipt capability while the flag is false. Enable staging only after Access, quotas, CSP, and migrations pass.

- [ ] **Step 4: Complete staging household validation**

Using synthetic receipt images, verify capture/review from the actual iPhone, collaborative edit conflict, 90-day timestamps, local image behavior, and zero changes in Mac SQLite and published financial aggregates.

- [ ] **Step 5: Deploy Phase A production and document rollback**

Apply production migration, deploy with the flag still false, verify Access, then enable `FEATURE_RECEIPT_DRAFTS`. Rollback disables only the feature flag; it does not delete drafts. Record Worker version IDs and D1 migration evidence without financial/user data.

- [ ] **Step 6: Commit Task 5**

```bash
git add frontend/e2e/receipt-drafts.spec.ts docs/receipt-drafts-runbook.md REMOTE_VIEWER_RUNBOOK.md remote/wrangler.viewer.jsonc
git commit -m "docs: add receipt draft rollout and recovery"
```

---

## Phase B — Matching and Authoritative Mac Application

### Task 6: Detailed Local Splits and Receipt Ledger Schema

**Files:**
- Create: `src/fintracka/migrations/021_receipt_splits.sql`
- Create: `src/fintracka/receipts.py`
- Create: `tests/test_receipts.py`
- Modify: `src/fintracka/db.py`
- Modify: `src/fintracka/ledger.py`
- Modify: `src/fintracka/api.py`
- Modify: `src/fintracka/reports.py`
- Modify: `src/fintracka/planning.py`
- Modify: `src/fintracka/exports.py`
- Modify: `src/fintracka/financial_mutations.py`
- Modify: relevant report/planning/export tests

**Interfaces:**
- Produces: `DetailedSplitInput`, `ReceiptDocument`, `ReceiptApplyResult` dataclasses.
- Produces: `set_detailed_splits(connection, transaction_id, splits, *, expected_split_revision, source) => int`.
- Produces: `apply_receipt_document(connection, transaction_id, document, *, expected_split_revision, command_id, actor) => ReceiptApplyResult`.
- Retains: existing `set_splits(...)` API as a backward-compatible manual wrapper.

- [ ] **Step 1: Write migration-preservation and domain tests**

Start from a pre-021 database containing manual split rows. Assert backup creation, row preservation, default/null compatibility, `foreign_key_check`, split revision zero, exact owner/category/subcategory inheritance, invalid parent/subcategory rejection, duplicate receipt-line rejection, exact sum, correction replacement, and rollback.

- [ ] **Step 2: Run receipt domain tests and verify RED**

Run: `.venv/bin/pytest tests/test_receipts.py -q`
Expected: FAIL because migration/domain do not exist.

- [ ] **Step 3: Implement migration and local receipt domain**

Add transaction `split_revision`; detailed split columns; local receipt/current revision/line tables; application/undo audit tables; and indexes. Add migration 21 to the pre-migration backup set in `db.py`.

- [ ] **Step 4: Extend reporting and financial consumers**

For split parents, use `COALESCE(split.spending_owner, transaction.spending_owner, account.spending_owner)`, split category/subcategory when present, and child amounts only. Ensure Savings draws and exports see one financial amount, not parent plus children.

- [ ] **Step 5: Add regression tests for all consumers**

Assert David/Ariela/Shared totals, category/subcategory drilldowns, Planning actuals, Savings linked draws, report flow paths, exports, manual split endpoints, and legacy split fixtures. Include command replay after local receipt commit and owner reporting.

- [ ] **Step 6: Verify and commit Task 6**

Run:

```bash
.venv/bin/pytest tests/test_receipts.py tests/test_financial_integrity.py tests/test_budgets_reports.py tests/test_planning.py tests/test_savings.py tests/test_api.py -q
```

Commit:

```bash
git add src/fintracka/migrations/021_receipt_splits.sql src/fintracka/receipts.py src/fintracka/db.py src/fintracka/ledger.py src/fintracka/api.py src/fintracka/reports.py src/fintracka/planning.py src/fintracka/exports.py src/fintracka/financial_mutations.py tests
git commit -m "feat: add authoritative receipt-backed splits"
```

### Task 7: Snapshot v3 and Receipt Matching Capability

**Files:**
- Modify: `src/fintracka/remote_models.py`
- Modify: `src/fintracka/remote_snapshot.py`
- Modify: `tests/test_remote_snapshot.py`
- Modify: `tests/fixtures/remote_snapshot_v2.json`
- Create: `tests/fixtures/remote_snapshot_v3.json`
- Modify: `remote/src/contract.ts`
- Modify: `remote/tests/contract-fixture.test.ts`
- Modify: `frontend/src/viewer/model.ts`
- Modify: `frontend/tests/viewer-model.test.ts`

**Interfaces:**
- Consumes: `transactions.split_revision` from Task 6.
- Produces: strict `RemoteSnapshotV3` accepted alongside v1/v2.
- Produces: transaction `split_revision` and receipt matching capability `transaction.apply_receipt_split: [1]`.

- [ ] **Step 1: Write failing Python/TypeScript v3 contract tests**

Assert v1/v2 compatibility, strict v3 fields, nonnegative split revision, capability absence when matching disabled, unknown command/receipt capability rejection, and round-trip fixture equality.

- [ ] **Step 2: Implement v3 models and publisher output**

Do not alter v2 meaning. Add explicit `mobile_receipt_matching_enabled` input to snapshot construction; never infer it from generic command enabled state.

- [ ] **Step 3: Deploy readers before writers in staging**

Build/deploy Publisher and Viewer that accept v1/v2/v3 while production still publishes v2. Verify old snapshots render and receipt matching remains hidden.

- [ ] **Step 4: Verify and commit Task 7**

Run:

```bash
.venv/bin/pytest tests/test_remote_snapshot.py tests/test_remote_service.py -q
npm --prefix remote run test:ci -- tests/contract-fixture.test.ts
npm --prefix frontend test -- --run tests/viewer-model.test.ts
npm --prefix remote run typecheck
npm --prefix frontend run typecheck:viewer
```

Commit:

```bash
git add src/fintracka/remote_models.py src/fintracka/remote_snapshot.py tests/test_remote_snapshot.py tests/fixtures remote/src/contract.ts remote/tests/contract-fixture.test.ts frontend/src/viewer/model.ts frontend/tests/viewer-model.test.ts
git commit -m "feat: publish receipt matching revisions"
```

### Task 8: Typed Receipt Split Command and Match Submission

**Files:**
- Create: `remote/migrations/0004_receipt_commands.sql`
- Modify: `remote/src/mobileCommandModel.ts`
- Modify: `remote/src/mobileCommandStore.ts`
- Modify: `remote/src/receiptStore.ts`
- Modify: `remote/src/receiptGateway.ts`
- Modify: `remote/src/mobileGateway.ts`
- Modify: `remote/tests/mobile-command-store.test.ts`
- Modify: `remote/tests/mobile-gateway.test.ts`
- Modify: `remote/tests/receipt-store.test.ts`
- Modify: `remote/tests/receipt-gateway.test.ts`

**Interfaces:**
- Consumes: immutable receipt revision/digest from Task 2 and split revision from Task 7.
- Produces: `CreateReceiptSplitCommandSchema` and generic `CreateMobileCommandSchema` union.
- Produces: `POST /api/v1/mobile/receipts/{id}/match` and claimed `transaction.apply_receipt_split/v1`.
- Produces: receipt completion result `{status, receipt_id, split_revision, split_count}` or safe conflict/rejection.

- [ ] **Step 1: Write failing migration/command-union tests**

Preserve v1/v2 classification commands/events through `0004`; accept only receipt command v1; canonical digest includes draft ID/revision/allocation digest/split revision; payload remains bounded; command type/payload mismatches fail; replay is stable; one active target rule still applies.

- [ ] **Step 2: Implement the command schema/store generalization**

Keep classification APIs and serialized rows backward-compatible. Use discriminated command/result types rather than optional receipt fields on classification objects.

- [ ] **Step 3: Write failing match-route tests**

Cover exact amount/currency/date gates, archived/tombstoned/already-bound denial, amount-only candidate requiring explicit selection, stale draft revision, stale snapshot split revision, immutable revision/digest binding, replacement, household authorization, quota, and D1 atomicity between command creation and draft `match_pending` status.

- [ ] **Step 4: Implement match submission and Mac revision fetch**

The browser never sends line descriptions in the command payload. The Mac fetch route requires command service identity and exact `(draft_id, revision, digest)`.

- [ ] **Step 5: Verify and commit Task 8**

Run:

```bash
npm --prefix remote run test:ci -- tests/mobile-command-store.test.ts tests/mobile-gateway.test.ts tests/receipt-store.test.ts tests/receipt-gateway.test.ts
npm --prefix remote run typecheck
```

Commit:

```bash
git add remote/migrations/0004_receipt_commands.sql remote/src remote/tests
git commit -m "feat: queue matched receipt split commands"
```

### Task 9: Mac Receipt Command Client and Exact-Once Processor

**Files:**
- Modify: `src/fintracka/mobile_command_client.py`
- Modify: `src/fintracka/mobile_command_service.py`
- Modify: `src/fintracka/remote_models.py`
- Modify: `tests/test_mobile_command_client.py`
- Modify: `tests/test_mobile_command_service.py`
- Modify: `tests/test_receipts.py`

**Interfaces:**
- Consumes: receipt command/revision endpoint from Task 8 and `apply_receipt_document` from Task 6.
- Produces: `ClaimedReceiptSplitCommand`, `MobileCommandClient.get_receipt_revision(...)`, and receipt command dispatch.
- Produces: safe applied/conflict/rejected results matching Task 8.

- [ ] **Step 1: Write failing client parser and fetch tests**

Assert strict command union parsing, unknown version/type rejection, bounded immutable receipt response, digest verification, no redirect/CORS credential leakage, retry semantics, and safe error mapping.

- [ ] **Step 2: Write failing processor tests**

Cover successful apply, stale split revision, pending-to-posted canonical target, ambiguous/disappeared target, amount/currency/sign mismatch, archived target, invalid owner/taxonomy, unassigned/mismatched lines, another receipt binding, correction replacement, receipt-fetch failure, receipt insert failure rollback, completion failure after commit, repeated claim/replay no-op, and one snapshot publication per batch.

- [ ] **Step 3: Implement client and dispatch**

Verify command payload digest before fetching; verify immutable receipt revision digest after fetching; call the shared receipt domain; store permanent receipt with command type/version/digest/actor/result inside the same SQLite transaction.

- [ ] **Step 4: Verify exact-once and rollback boundaries**

Run:

```bash
.venv/bin/pytest tests/test_mobile_command_client.py tests/test_mobile_command_service.py tests/test_receipts.py -q
```

Expected: every replay test leaves one local receipt revision, one active split set, one command receipt, and unchanged audit counts after the first application.

- [ ] **Step 5: Commit Task 9**

```bash
git add src/fintracka/mobile_command_client.py src/fintracka/mobile_command_service.py src/fintracka/remote_models.py tests/test_mobile_command_client.py tests/test_mobile_command_service.py tests/test_receipts.py
git commit -m "feat: apply mobile receipt splits exactly once"
```

### Task 10: Candidate Matching, Pending State, and Correction UI

**Files:**
- Create: `frontend/src/viewer/receipts/ReceiptMatchPage.tsx`
- Modify: `frontend/src/viewer/receipts/receiptApi.ts`
- Modify: `frontend/src/viewer/receipts/ReceiptInboxPage.tsx`
- Modify: `frontend/src/viewer/receipts/ReceiptReviewPage.tsx`
- Modify: `frontend/src/viewer/receipts/types.ts`
- Modify: `frontend/src/viewer/receipts/ReceiptProvider.tsx`
- Modify: `frontend/src/viewer/mobileCommands.ts`
- Create: `frontend/tests/receipt-matching.test.tsx`
- Modify: `frontend/src/viewer/viewer.css`

**Interfaces:**
- Consumes: snapshot v3/transactions, receipt APIs, and command status from Tasks 7–9.
- Produces: deterministic `scoreReceiptCandidates(draft, transactions) => ReceiptCandidate[]`.
- Produces: explicit match review, Pending Mac, Matched, Conflict, and corrected re-application flows.

- [ ] **Step 1: Write failing candidate/unit tests**

Assert exact amount/currency gates; merchant/date/payment-hint ranking; amount-only never auto-confirms; pending/posted labels; already-bound exclusion; stable tie order; no candidate when data is stale/ineligible; and explanations for every score component.

- [ ] **Step 2: Write failing component tests**

Assert explicit candidate tap plus confirmation; owner/category totals preview; no optimistic financial aggregate change; offline pending state; conflict current-vs-proposed revision; cancellation/replacement; matched read-only view; edit creates a new revision; corrected re-application warns that prior receipt-created splits will be replaced.

- [ ] **Step 3: Implement matching and correction UI**

Keep proposals visually separate from committed snapshot data. Refresh receipt command status on focus/60-second interval using the existing mobile command provider pattern without copying receipt lines into generic command state.

- [ ] **Step 4: Verify and commit Task 10**

Run:

```bash
npm --prefix frontend test -- --run tests/receipt-matching.test.tsx tests/receipt-pages.test.tsx
npm --prefix frontend run typecheck:viewer
npm --prefix frontend run build:viewer
```

Commit:

```bash
git add frontend/src/viewer/receipts frontend/src/viewer/viewer.css frontend/tests/receipt-matching.test.tsx
git commit -m "feat: match and correct mobile receipts"
```

### Task 11: Desktop Receipt Detail and Cross-Surface Regression

**Files:**
- Create: `frontend/src/receipts/ReceiptDetail.tsx`
- Create: `frontend/tests/receipt-detail.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `src/fintracka/api.py`
- Modify: `tests/test_api.py`
- Create: `frontend/e2e/receipt-workflow.spec.ts`

**Interfaces:**
- Consumes: local receipt records and detailed splits from Task 6.
- Produces: authenticated local receipt-detail API and transaction-drawer receipt view.
- Produces: full mobile-to-Mac-to-republished-snapshot E2E coverage.

- [ ] **Step 1: Write failing local API/detail tests**

Assert a matched transaction exposes receipt status, item description, owner, category/subcategory, tax allocation, and application history; unrelated transactions expose no receipt; no raw provider payload or cloud credential appears.

- [ ] **Step 2: Implement desktop receipt detail**

Add a read-only structured receipt section to transaction details with owner-color summaries and prior application/correction history. Desktop manual split editing remains compatible and increments split revision.

- [ ] **Step 3: Add full synthetic E2E**

Capture a multi-page synthetic receipt, correct one OCR line, assign A/D/S, save unmatched, publish a matching transaction, submit, manually process, verify applied state, owner/category report totals, replay no-op, then correct/reapply and verify replacement rather than duplication.

- [ ] **Step 4: Run cross-surface verification and commit**

Run:

```bash
.venv/bin/pytest tests/test_api.py tests/test_receipts.py tests/test_budgets_reports.py -q
npm --prefix frontend test -- --run tests/receipt-detail.test.tsx tests/receipt-matching.test.tsx
npm --prefix frontend run test:e2e -- receipt-workflow.spec.ts
```

Commit:

```bash
git add frontend/src/receipts frontend/src/App.tsx frontend/src/styles.css frontend/tests frontend/e2e/receipt-workflow.spec.ts src/fintracka/api.py tests/test_api.py
git commit -m "feat: show committed receipt details"
```

---

## Phase C — Refinement, Security Review, and Production Rollout

### Task 12: Extraction Refinements and Production Reconciliation

**Files:**
- Modify: `frontend/src/viewer/receipts/receiptParser.ts`
- Modify: `frontend/tests/receipt-parser.test.ts`
- Create: `docs/receipt-processing-runbook.md`
- Modify: `REMOTE_VIEWER_RUNBOOK.md`
- Modify: `FINTRACKA_RESEARCH_HANDOFF.md` if present and still authoritative
- Modify: `README.md`

**Interfaces:**
- Consumes: complete Phases A and B.
- Produces: production-enabled receipt matching with rollback, retention, and recovery evidence.

- [ ] **Step 1: Expand synthetic extraction corpus**

Add receipts with exempt groceries, item-level/receipt-level discounts, duplicate legitimate products, long overlaps, tips, service fees, noisy totals, and missing subtotal. Pin expected parser candidates and review flags; do not make uncertain extraction silently definitive.

- [ ] **Step 2: Run full correctness/security verification**

Run:

```bash
./scripts/verify.sh
npm --prefix remote run check:deployment
npm audit --prefix frontend --omit=dev
npm audit --prefix remote --omit=dev
.venv/bin/pip-audit
git diff --check
```

Additionally verify CSP/network logs show no third-party OCR/image/text request; D1 contains no images/full card numbers; logs contain no receipt text/amounts; API quotas and oversized bodies fail safely; and both Access identities have only intended household permissions.

- [ ] **Step 3: Deploy readers/migrations/writers in safe order**

1. Apply `0004` staging twice and deploy Worker readers.
2. Migrate a copied/synthetic local database through `021` and run `foreign_key_check`.
3. Publish snapshot v3 only after deployed Viewer/Publisher accept it.
4. Keep matching capability false while drafts remain usable.
5. Repeat migration/deploy order in production with verified backups and rollback commands.

- [ ] **Step 4: Controlled live reconciliation**

With a user-selected harmless real receipt/transaction: record target split revision and relevant counts locally; submit one match; manually process once; verify exact sum, A/D/S/category reporting, command/draft/local audit status, one snapshot publication, and replay no-op. Then make one deliberate correction and verify atomic replacement/replay. Never choose the receipt or classification for the user.

- [ ] **Step 5: Enable automatic receipt processing and verify recovery**

Enable the receipt matching capability and existing once-per-minute processor only after Step 4 passes. Verify Mac-off pending behavior, restart recovery, expired draft/command cleanup, disabled-feature rollback, and local restore from a pre-migration verified backup.

- [ ] **Step 6: Document evidence and explicitly defer cloud images**

Record Worker version IDs, D1 migrations, snapshot schema/capabilities, test commands, live reconciliation result counts, free-tier estimate, rollback, and retention job. State that original images remain local and that encrypted cloud image persistence requires the separate backup/recovery project.

- [ ] **Step 7: Commit Task 12**

```bash
git add frontend/src/viewer/receipts/receiptParser.ts frontend/tests/receipt-parser.test.ts docs/receipt-processing-runbook.md REMOTE_VIEWER_RUNBOOK.md README.md FINTRACKA_RESEARCH_HANDOFF.md
git commit -m "docs: complete receipt workflow rollout"
```

---

## Final Integration

- [ ] Confirm every task commit is present and the working tree contains only known unrelated user files.
- [ ] Run `./scripts/verify.sh` once more from the integration branch.
- [ ] Request a correctness/security review focused on authority boundaries, exact cents, D1 concurrency, command replay, image privacy, and migration preservation.
- [ ] Fix only verified findings and rerun affected tests plus the full verification suite.
- [ ] Push the branch, create the PR, wait for CI, merge after green, and safely update the desktop main checkout without overwriting unrelated local files.
- [ ] Verify the desktop launcher rebuilds the merged frontend and the production phone Viewer reports the deployed receipt capabilities.
