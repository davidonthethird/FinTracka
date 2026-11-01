# Mobile Receipt Scanning and Item-Level Splitting Design

**Date:** October 31, 2026
**Status:** Approved November 1, 2026
**Roadmap item:** 2 — Mobile receipt scanning, ownership splitting, and later matching
**Builds on:** `2026-10-30-mobile-transaction-editing-design.md` and `2026-10-30-mobile-scoped-classification-design.md`

## Intent

Let David or Ariela photograph a receipt on an iPhone, correct the extracted items, assign every item to David, Ariela, or Shared, and save the work while the Mac is offline. The receipt remains a non-financial draft until a household member explicitly matches it to one canonical bank transaction and the Mac validates and applies an exact-cent split.

The feature must remain free to operate, keep OCR on the phone, preserve the Mac SQLite ledger as the financial authority, and never invent a transaction merely because a receipt was scanned.

## Confirmed product decisions

- Use the existing mobile web Viewer rather than creating a native iOS application.
- OCR runs on the iPhone in the browser using self-hosted Tesseract.js/WebAssembly. No OCR code, language model, image, or receipt text is loaded from or sent to a third-party CDN/API.
- Manual correction is a first-class path; OCR output is always a suggestion.
- Both household members may create, edit, view, match, and correct household receipt drafts.
- Item ownership uses the existing visual convention: David blue, Ariela pink, Shared dark purple.
- Structured unmatched drafts are cloud-authoritative collaboration data. They are not financial ledger records.
- Original receipt images are initially local to the phone browser and are not uploaded to Cloudflare. Durable encrypted image upload is deferred until verified encrypted off-device recovery exists.
- A matched receipt is committed through a new typed, versioned mobile financial command. The browser never writes transaction splits directly.
- All amounts are integer minor units. A receipt cannot be submitted for financial application unless its reconciled total exactly equals the selected bank transaction.
- No paid OCR, LLM, image-storage, or bank-refresh service is introduced.

## Goals

1. Capture or import one or more receipt pages, including overlapping photos of a long receipt.
2. Extract merchant/date/items/totals locally and show confidence or uncertainty.
3. Let the user correct lines, quantities, prices, discounts, taxability, tax, fees, and totals.
4. Assign every financially relevant line to David, Ariela, or Shared and optionally choose category/subcategory.
5. Reconcile items, discounts, tax, tip, and fees to the receipt total with deterministic penny allocation.
6. Save and collaborate on an unmatched draft while the Mac is offline.
7. Suggest likely transactions without treating amount equality as proof.
8. Apply a confirmed receipt to the canonical transaction exactly once after Mac validation.
9. Preserve an audit trail and permit an explicit corrected re-application without double-counting.

## Non-goals

- Creating a bank transaction from a receipt.
- Independent bank synchronization while the Mac is off.
- Paid cloud OCR/LLM services or sending images to third-party AI services.
- Native iOS/App Store distribution in this project.
- Automatic matching based only on total amount.
- Uploading original receipt images in the initial release.
- Return/refund receipts, foreign-exchange receipts, gift-card activation, or invoices with later partial payments in the initial release.
- Automatically learning merchant categorization rules from receipt lines.
- Converting FinTracka into a general bookkeeping/inventory system.

## Approaches considered

### 1. Mobile web with self-hosted on-device OCR — selected

Extend the existing Access-protected Viewer. Capture/import images through the browser, preprocess them locally, lazy-load self-hosted Tesseract worker/core/language assets, and keep image blobs in origin-private browser storage. Persist only reviewed structured drafts to the existing Cloudflare application.

This preserves the current deployment and identity model, adds no recurring service cost, works while the Mac is offline, and keeps images off third-party services. The tradeoff is slower and less accurate OCR than Apple Vision, so the review UI and manual-entry path must remain excellent.

### 2. Native iOS companion using Vision/VisionKit — deferred

Apple Vision offers stronger private on-device OCR and document-camera behavior. It would require a separate Swift application, signing/distribution, a second client/authentication surface, and ongoing platform maintenance. The draft and command contracts in this design deliberately remain usable by a future native scanner.

### 3. Phone capture with Mac-only OCR — rejected

This would minimize browser work, but the user could not immediately review and assign items while the Mac is off. It fails the main product goal.

## Phased delivery

### Phase A — capture, OCR, review, and unmatched drafts

- Add the Receipt Inbox and capture/review wizard.
- Support multiple images, local crop/rotate/reorder/remove, local OCR, overlap review, item ownership, optional line classification, and exact receipt reconciliation.
- Save the reviewed structured draft to D1 with status `waiting_for_bank`.
- Keep images local to the creating browser; make that limitation visible.

This phase is useful independently and makes no financial mutation.

### Phase B — candidate matching and authoritative split application

- Calculate safe transaction candidates from the latest snapshot.
- Require explicit confirmation of one candidate.
- Queue `transaction.apply_receipt_split/v1`.
- Let the Mac fetch the referenced reviewed draft, validate it, atomically apply splits, write audit/receipt records, and republish the snapshot.
- Support conflict review and corrected re-application.

### Phase C — extraction refinements and optional protected image persistence

- Improve overlap assistance, receipt-layout parsing, tax exceptions, and confidence cues using synthetic fixtures.
- After encrypted off-device backup/recovery is implemented and tested, separately design optional encrypted R2 image retention. It is not implicitly enabled by Phases A or B.

## Authority domains

| Data | Authority | Meaning |
|---|---|---|
| Original page images | Creating phone browser initially | Temporary capture aid; not financial truth |
| Unmatched receipt draft and lines | Cloud D1 | Collaborative proposal/editing state |
| Receipt command lifecycle | Cloud D1 command queue | Proposed financial mutation and status |
| Transactions, committed splits, matched receipt record | Mac SQLite | Authoritative financial record |
| Viewer snapshot | Private R2 read model | Last published committed state |

The interface must label `waiting_for_bank`, `match_pending`, and `processing` as uncommitted. Planning, Savings, Overview, and Reports continue to use only committed snapshot data.

## User experience

### Entry points

- Add **Scan receipt** to the Transactions toolbar.
- Add **Receipt Inbox** from Transactions without consuming another bottom-navigation slot.
- The inbox groups `Needs review`, `Waiting for bank`, `Match suggested`, `Pending Mac`, `Matched`, and `Conflict`.

### Capture and OCR

1. Choose camera or photo library.
2. Add up to 12 pages; show thumbnails and local storage usage.
3. Rotate, crop, reorder, remove, or retake pages before OCR.
4. Downscale a working copy to a bounded OCR resolution while preserving the local original until the draft is matched/deleted or local retention expires.
5. Lazy-load the self-hosted OCR worker and English model only after the user starts scanning.
6. Show per-page progress and allow cancellation/retry. A failed page can be entered manually without blocking the others.
7. Normalize recognized lines while preserving page/position/confidence metadata.
8. Detect likely overlapping line sequences between adjacent pages. High-confidence exact duplicates are collapsed; uncertain overlaps remain visible as a review group and are never silently removed.

### Review and ownership

- Present an editable line list with description, quantity, unit/line price, discount, taxable status, allocated tax, category, subcategory, and A/D/S owner.
- Allow multi-select owner/category assignment and manual add/remove/reorder.
- Visually flag missing owner, invalid price, uncertain OCR, suspected duplicate, and total mismatch.
- Category is optional. When absent, the split may inherit the parent transaction category; explicit line categories override it.
- Subcategory is valid only under its selected category.
- A sticky reconciliation footer displays:

  `item totals - discounts + allocated tax + tip + fees = receipt total`

- Final review is disabled until the difference is exactly zero cents and every included item has an owner.

### Save and match

- Saving creates/updates a structured draft and clearly says that no spending has been added.
- Candidate matching compares the latest published transactions using amount/currency, merchant similarity, purchase/authorization/posting date distance, pending/posted state, and optional masked payment hint.
- The candidate card explains each factor and discrepancy. Amount equality alone never produces an automatic match.
- The user explicitly selects one transaction and reviews the proposed owner/category totals before submitting.
- The phone shows `Pending Mac`, then `Matched`, `Conflict`, or `Needs review` after processing.

### Correction after matching

A matched receipt remains readable. Editing creates a new draft revision and requires a new explicit submission against the current transaction split revision. The Mac replaces the prior receipt-created splits atomically and records the previous values in an undo/audit batch. It never layers a second set of splits on top.

## Browser capture and local image handling

- Use `<input type="file" accept="image/*" capture="environment" multiple>` plus photo-library import.
- Use Canvas/ImageBitmap for orientation, bounded resize, crop, and OCR preprocessing.
- Store local page blobs in IndexedDB under opaque draft/page IDs; never use `localStorage`, HTTP cache, analytics, or logs for image/text data.
- Request persistent origin storage when supported, but treat it as best-effort. Display when images exist only on this device and when the browser reports storage pressure.
- Default local image retention is 30 days after last edit. Delete local images immediately when the user deletes the draft, and after successful match unless the user explicitly retains them until the 30-day limit.
- Structured cloud drafts survive local image eviction; the UI allows reattaching pages or continuing with the reviewed lines.
- Revoke object URLs promptly and clear in-memory image buffers after processing.

## OCR and parsing boundary

Create an internal browser interface independent from Tesseract:

```ts
interface ReceiptOcrEngine {
  recognize(pages: PreparedReceiptPage[], signal: AbortSignal): Promise<OcrReceiptPage[]>;
}
```

The parser consumes normalized text observations and returns receipt-field candidates with source page, bounding box, and confidence basis points. OCR and parsing remain separate so a future Vision client can submit the same normalized observations or directly submit reviewed draft lines.

Tesseract worker, WASM core, and English trained data are pinned, self-hosted build assets with integrity/version tests. No runtime CDN fallback is allowed. Viewer CSP permits only the minimum same-origin worker/WASM behavior required by the pinned implementation.

## Exact-cent reconciliation

All stored receipt monetary values are nonnegative integer cents in the v1 draft contract; discounts are nonnegative subtractive values. The Mac converts a purchase receipt into negative transaction split amounts only when applying it to a negative bank transaction.

### Allocation rules

1. Preserve printed item-level tax and discounts when confidently associated with a line.
2. For receipt-level tax, use only taxable post-discount item amounts as the allocation basis.
3. For receipt-level discounts without an explicit target, allocate across eligible positive item amounts.
4. Allocate tip and general fees across positive post-discount item amounts unless the user manually assigns them.
5. Use largest-remainder allocation: calculate integer floors, then assign leftover cents by descending fractional remainder with stable line order as the tie-breaker.
6. Never allocate to a zero/negative basis. If no valid basis exists, require manual assignment.
7. The sum of final line allocations must equal the entered receipt total exactly.

The UI always exposes calculated allocations and lets the user override them while preserving the exact-total invariant.

## Cloud receipt contract and storage

Receipt drafts use their own versioned contract (`receipt_draft/v1`) and D1 tables. They are not embedded in financial snapshots or `payload_json` blobs.

### `receipt_drafts`

- stable ID, household ID, creator member ID;
- contract version and monotonic `revision`;
- status: `editing`, `waiting_for_bank`, `match_pending`, `processing`, `matched`, `conflict`, `dismissed`;
- merchant, purchase date, currency, masked payment hint;
- subtotal, discount, tax, tip, fees, and total in integer minor units;
- selected transaction ID/revision only after explicit match selection;
- allocation digest and safe terminal error code;
- created/updated/last-activity/retention timestamps.

### `receipt_lines`

- stable line ID and draft ID;
- order and source-page/observation references;
- description, quantity as a bounded decimal string, unit and line amounts;
- discount/tax/fee allocations in integer minor units;
- taxable state, owner, optional category/subcategory IDs;
- confidence basis points and explicit manual-review flags.

### `receipt_revisions`

Every successful draft save also writes one immutable, canonical structured revision and digest. Receipt commands reference this revision, never the mutable current rows. The Mac-only fetch route returns the exact referenced revision, so later household edits cannot change a pending command's meaning. Revision bodies have the same 256 KiB limit and follow the draft's retention lifecycle.

### `receipt_events`

Append safe audit events for create, update, owner/category changes, match selection, command submission, conflict, application, correction, dismissal, and retention cleanup. Events must not copy full OCR text or images.

### Retention

- Active unmatched drafts expire after 90 days without activity, with a visible warning beginning 14 days before expiry. Any edit resets activity.
- Dismissed drafts and terminal cloud command details are removed after 90 days.
- After successful Mac application, D1 retains the structured matched draft/status for 90 days, then removes receipt lines and keeps only the command/event lifecycle already permitted by existing retention.
- The Mac keeps the authoritative structured matched receipt and audit history according to local financial-retention policy.

## Receipt API

All routes reuse the existing same-origin Cloudflare Access household identity. They enforce strict JSON schemas, household scoping, optimistic revision, rate/size limits, and no permissive CORS.

- `GET /api/v1/mobile/receipts` — list household drafts/status summaries.
- `POST /api/v1/mobile/receipts` — create an empty or reviewed v1 draft with an idempotency key.
- `GET /api/v1/mobile/receipts/{id}` — retrieve the structured draft and lines.
- `PUT /api/v1/mobile/receipts/{id}` — atomically replace reviewed structured fields/lines using `expected_revision`.
- `POST /api/v1/mobile/receipts/{id}/dismiss` — dismiss an unmatched draft.
- `POST /api/v1/mobile/receipts/{id}/match` — select a snapshot transaction and create the typed financial command after server-side validation.
- `GET /api/v1/mobile/mac/receipts/{id}` — Mac-only fetch of an immutable command-referenced draft revision.

Initial bounds: 12 pages of metadata, 250 reviewed lines, 256 KiB structured draft body, 20 active drafts per household, and 30 draft writes per member per hour. Images are not accepted by these routes.

Concurrent edits return `409 RECEIPT_REVISION_CONFLICT` and show the latest draft for review. The cloud never merges two line arrays silently.

## Matching model

Candidate scoring is deterministic and explainable. The phone may calculate presentation ordering from the active snapshot, but the Worker revalidates the submitted candidate against that same snapshot before queueing.

Required gates:

- transaction is not archived/tombstoned;
- currency matches;
- absolute transaction amount equals the reconciled receipt total for direct matching;
- transaction is not already bound to another active/matched receipt;
- purchase date is within the configured authorization/posting window.

Ranking signals include normalized merchant similarity, date distance, pending/posted status, and masked payment hint. A candidate may be suggested, never auto-confirmed. Amount discrepancies route to receipt review rather than force matching in the initial release.

## Financial command contract

Add `transaction.apply_receipt_split/v1` to the existing typed command union. Its small canonical payload contains:

```json
{
  "receipt_draft_id": "stable-id",
  "receipt_revision": 4,
  "allocation_digest": "sha256",
  "observed_split_revision": 2
}
```

The command target is the selected canonical transaction. It does not duplicate receipt descriptions or amounts in the generic command row. The Mac claims the command and fetches that exact immutable receipt revision through the Mac-only receipt endpoint.

Only one active receipt command may target a transaction. Replacement follows the existing immutable-command/supersession behavior. Completion returns status, final split revision, receipt ID, and split count—never merchant, line descriptions, or amounts.

## Mac ledger changes

### Optimistic revision

Add `split_revision` to transactions. It increments only when committed transaction splits or a receipt match change. Publish it with transaction candidates. Desktop split edits and receipt commands use the same revision check.

### Local receipt records

Add local `receipts`, `receipt_lines`, and receipt-application audit/undo tables. A matched cloud draft is copied into SQLite in the same transaction that applies its splits. The local tables preserve the reviewed line detail after D1 retention expires.

### Transaction splits

Extend `transaction_splits` with:

- `spending_owner` (`David`, `Ariela`, `Shared`);
- optional `subcategory_id` constrained to its parent category;
- optional `receipt_line_id` linking matched receipt detail;
- source marker distinguishing manual and receipt-created splits.

Existing split rows remain valid and inherit the parent transaction owner when no split owner is present. Reporting, Planning, Savings draws, exports, and drill-downs use split owner/category/subcategory where present and continue to count only child amounts when `has_splits = 1`.

### Apply transaction

The Mac processor performs one SQLite transaction:

1. Validate command/claim/draft digests and exact immutable draft revision.
2. Resolve the canonical transaction and verify `observed_split_revision`.
3. Reject pending ambiguity, archived/tombstoned targets, wrong currency/sign/amount, another matched receipt, invalid taxonomy, unassigned lines, or reconciliation mismatch.
4. Copy the structured receipt revision into local receipt tables.
5. Convert reviewed line allocations to exact signed splits.
6. Replace only the target's prior receipt-created split set, increment `split_revision`, and reconcile downstream financial mutations.
7. Write audit/undo data and the permanent mobile-command receipt.
8. Commit once, acknowledge the command, and publish one refreshed snapshot.

Replay returns the permanent receipt without changing the ledger. Any error rolls back receipt rows, splits, downstream reconciliation, audit batch, and receipt together.

## Security and privacy

- Cloudflare Access identity is resolved server-side; actor/household from request bodies is ignored/rejected.
- Browser receipt routes and Mac receipt routes retain distinct Access audiences.
- D1 stores reviewed receipt text and allocations but no raw bank payload, Plaid token, account credential, or full card number.
- Payment hints are optional and strictly masked.
- Original images never leave the phone in the initial release.
- OCR assets are self-hosted and CSP blocks third-party connections.
- React renders receipt text as data; no HTML rendering from OCR output.
- Logs and analytics contain IDs/status/error codes only, never images, descriptions, totals, or line content.
- Synthetic receipt images and transactions are used in all tests, fixtures, screenshots, and CI.
- Draft and command APIs enforce conservative quotas before parsing/storing large bodies.
- No receipt route grants archive, account, Plaid, taxonomy-admin, or arbitrary transaction-write access.

## Recovery and failure behavior

- If OCR crashes or memory pressure terminates the worker, preserve captured local pages and the last saved structured draft; allow per-page retry or manual entry.
- If local images are evicted, retain reviewed cloud lines and mark images unavailable on this device.
- If the Mac is offline, matching remains visibly pending and creates no financial change.
- If the bank transaction changes or is split elsewhere, return a conflict containing only safe current revision/status and require explicit resubmission.
- If a D1 draft update succeeds but the UI loses the response, the idempotency key retrieves the same revision.
- If command completion fails after local commit, the permanent local receipt makes retry a no-op.
- If snapshot publication fails after application, the command remains applied locally and publication retries without applying again.

## Capability and rollout

Version receipt boundaries independently:

- authenticated session capability `receipts: { drafts: [1] }` for Phase A cloud collaboration;
- snapshot capability `receipts: { matching: [1] }` plus `transaction.apply_receipt_split: [1]` only after the Mac publishes split revisions for Phase B;
- collaboration contract `receipt_draft/v1`;
- financial command `transaction.apply_receipt_split/v1`;
- local receipt schema migration and `split_revision`.

Rollout order:

1. Synthetic OCR/parser/reconciliation spike on representative one-page and long overlapping receipts; confirm acceptable iPhone memory/time before production UI work.
2. Deploy D1 draft schema and typed APIs with capabilities hidden.
3. Deploy phone capture/review/inbox with synthetic staging data and images kept local.
4. Enable Phase A production drafts after auth, quota, retention, XSS, and privacy verification.
5. Add local split schema/revision and desktop reporting compatibility.
6. Deploy receipt command contract disabled by capability.
7. Reconcile one synthetic then one user-selected real receipt manually, including replay and conflict tests.
8. Enable automatic Mac receipt-command processing only after exact totals, owner reporting, and idempotency are verified.

## Cost boundary

- Tesseract assets are bundled/self-hosted.
- D1 stores bounded structured drafts and events.
- R2 stores existing snapshots only; no receipt images initially.
- No paid API or new provider permission is activated.
- Before production enablement, estimate actual D1 rows/requests against Cloudflare's current free limits and stop rollout if expected household usage would require paid service.

## Acceptance criteria

- A household member can capture a one-page or overlapping multi-page receipt and complete review without the Mac online.
- OCR and image processing make no third-party network request and have a manual fallback.
- Duplicate overlap is surfaced safely; uncertain lines are never silently discarded.
- Every included item has A/D/S ownership and optional valid classification.
- Deterministic allocations reconcile to exactly one cent and collectively to the receipt total.
- Saving an unmatched draft never changes spending, balances, Planning, Savings, or Reports.
- A candidate requires explicit confirmation and more evidence than amount equality.
- The Mac rejects stale, mismatched, duplicate, invalid, or unreconciled commands without partial mutation.
- A successful application preserves the canonical transaction ID, replaces parent reporting with exact child splits, and reports owners/categories correctly.
- Replay cannot create duplicate local receipts or splits.
- Corrected re-application replaces the prior receipt-created splits atomically and retains audit history.
- Original images remain local and bounded until a separately approved encrypted image-retention design exists.
- The feature adds no recurring paid service.

## Builder calls made in this design

- Use 12 pages and 250 lines as initial safety limits; these may be lowered after the iPhone spike but not raised without load/security review.
- Use 90-day inactive/terminal structured-draft retention and 30-day best-effort local image retention.
- Limit initial direct matching to exact currency/amount purchases; discrepancies go back to review.
- Keep Receipt Inbox under Transactions instead of adding a sixth bottom-navigation item.
- Use explicit correction/re-application rather than a separate mobile undo command in the first release.
