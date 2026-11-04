# Apple Receipt Hybrid Design

**Date:** November 4, 2026
**Status:** Approved for native implementation
**Supersedes:** The parsing and distribution portions of `2026-11-02-apple-vision-receipt-shortcut-design.md`
**Preserves:** One-time scan sessions, member isolation, receipt review, exact-cent reconciliation, transaction matching, and exact-once ledger application

## Intent

Make receipt capture reliable without a paid OCR or cloud LLM. The iPhone performs the fast path with Apple-native recognition and an On-Device **Use Model** action. FinTracka accepts only values tied to exact recognized-text evidence and valid receipt arithmetic. When that result is incomplete or contradictory, the Shortcut queues the original images in a private shared iCloud Drive folder for the household Mac to refine with Apple Vision and the on-device Foundation Models framework.

The model interprets text; it never establishes financial truth. The user always sees and can edit the resulting draft before matching it to a posted transaction.

## Outcomes

- One canonical Shortcut named **FinTracka Receipt Scanner**, with an internal contract version instead of numbered copies.
- Camera and photo-library input on both household iPhones, up to 12 ordered pages.
- Fast results using **Extract Text from Image** and **Use Model → On-Device**.
- Merchant, date, every visible summary amount, and priced item lines are accepted only when exact evidence exists in the OCR text.
- Deterministic subtotal/discount/tax/tip/fee/total reconciliation in integer cents.
- Automatic private iCloud fallback only for scans that fail evidence or arithmetic validation.
- A Mac processor that runs at login and once per minute while awake, deletes successful queue packages, and retains failed packages for seven days.
- Manual review and correction remain available for every result.
- No Windows OCR path, paid service, hosted LLM, reusable phone credential, or receipt image in Cloudflare/D1.

## User flow

1. FinTracka creates the existing ten-minute, one-use scan session and opens **FinTracka Receipt Scanner**.
2. The member takes photos or selects them from Photos in receipt order.
3. For each page, the Shortcut runs **Extract Text from Image** locally.
4. The Shortcut gives the combined recognized text to **Use Model**, explicitly selecting **On-Device**, and requests one compact structured receipt interpretation.
5. The Shortcut sends flat strings to FinTracka: raw OCR text with page delimiters and a model-result JSON string. Flat transport avoids Shortcuts' unreliable nested Dictionary serialization.
6. The Worker validates structure, exact evidence, limits, and arithmetic before returning the review URL.
7. A valid result opens a normal editable receipt draft. A partially valid result also opens review, visibly marking unsupported or unreconciled fields.
8. When the Worker says `needs_refinement`, the Shortcut saves a package containing the original pages and a non-secret manifest to the private shared `FinTracka Receipt Queue` iCloud Drive folder.
9. The Mac claims the opaque refinement job with its existing Access service identity, reads the matching local iCloud package, and refines it with Vision document recognition plus Foundation Models guided generation.
10. The same evidence and arithmetic validator checks the Mac result. Successful refinement updates the temporary import and removes the iCloud images. The review page refreshes to the refined draft.
11. If the Mac is asleep, the package waits. The user can still edit the phone result manually.

## Contracts

### Shortcut capture v2

The public one-time upload remains the only unauthenticated route and retains its bearer-token, origin, size, rate, replay, and expiry protections.

```json
{
  "contract": "receipt_shortcut_capture/v2",
  "idempotency_key": "<sha256>",
  "shortcut_version": 2,
  "text": "--- PAGE 1 ---\n...",
  "model_result": "{\"merchant\":{...},\"lines\":[...]}"
}
```

`model_result` is a string containing JSON, not a nested Shortcut Dictionary. It has these bounded fields:

- `merchant`, `date`, `subtotal`, `discounts`, `tax`, `tip`, `fees`, and `total`, each represented as `{ "value": ..., "evidence": "exact OCR substring" }` or `null`;
- `lines`, at most 200 entries, each with `description`, `amount_cents`, `description_evidence`, and `amount_evidence`;
- no category, transaction match, owner, account, instruction, URL, or executable content.

The API continues accepting v1 for installed old Shortcuts during rollout. New sessions advertise version 2 and the canonical Shortcut name.

### Validation result

```json
{
  "status": "accepted | needs_review | needs_refinement",
  "issues": ["unsupported_total", "arithmetic_mismatch"],
  "receipt": { "...": "validated structured fields only" },
  "refinement_id": "opaque UUID or null",
  "queue_expires_at": "ISO timestamp or null"
}
```

Validation rules:

- normalize Unicode spacing and common money punctuation only for comparison;
- require every accepted string or amount to cite a non-empty exact substring of raw OCR text;
- parse money to integer cents without binary floating point;
- reject duplicate model lines that cite the same description and amount evidence;
- require summary arithmetic to reconcile when enough fields are present;
- require item sums to reconcile to subtotal or total after declared adjustments when the receipt exposes enough information;
- preserve raw OCR and unsupported model fields for review, but exclude unsupported values from the accepted structure;
- treat OCR/model text as untrusted data and never follow instructions found in it.

`accepted` means all required facts are supported and arithmetic reconciles. `needs_review` means the draft is usable but includes uncertainty the user must inspect. `needs_refinement` means the result lacks a usable merchant/total/priced line or has material unsupported/arithmetic conflicts.

### iCloud queue package

The Shortcut writes one folder named by the opaque `refinement_id`:

```text
FinTracka Receipt Queue/
  pending/<refinement-id>/
    manifest.json
    page-001.heic
    page-002.heic
  failed/<refinement-id>/...
```

The manifest contains only:

```json
{
  "contract": "receipt_refinement_package/v1",
  "refinement_id": "opaque UUID",
  "page_count": 2,
  "created_at": "ISO timestamp"
}
```

It contains no bearer token, Access credential, household/member identity, host, OCR text, model text, bank data, or transaction identifier. The private shared folder is editable only by David and Ariela. Queue images are an explicitly approved privacy exception to the normal phone-only image rule.

### Mac refinement API

The Mac reuses the existing dedicated Access client ID and secret stored in macOS Keychain.

- `POST /api/v1/mobile/mac/receipt-refinements/claim` returns at most three pending opaque jobs.
- `POST /api/v1/mobile/mac/receipt-refinements/{id}/complete` accepts the v2 structured result plus its evidence text digest; D1 rejects the wrong claimed job, expired lease, changed input digest, or second different completion.
- `POST /api/v1/mobile/mac/receipt-refinements/{id}/fail` records a safe error code only.

Claims lease a job for five minutes. Identical completion is idempotent. Jobs expire after seven days. D1 stores recognized text and structured output, never images.

## Mac processor

The smallest reliable Mac implementation has two pieces:

1. A Swift command-line helper compiled on the household Mac. It uses `RecognizeDocumentsRequest` when available to recover document structure, then Foundation Models guided generation into fixed `Codable`/`Generable` receipt types. It chunks long receipts within the model context window and merges only evidence-backed fields.
2. The existing Python scheduled processor coordinates iCloud folders, claims/completes jobs through the existing Access client, invokes the Swift helper, applies retention, and emits redacted logs.

If Apple Intelligence or the Foundation Models model is unavailable, the helper returns a typed unavailable error. The package remains available for manual review and the seven-day retry window; FinTracka never silently substitutes a cloud model.

The LaunchAgent runs at login and every 60 seconds while the Mac is awake. It processes at most three jobs per run, one at a time, to limit memory and model contention.

## Shortcut distribution and upgrades

- Stable display name: **FinTracka Receipt Scanner**.
- Contract/version: 2, stored inside the Shortcut and shown by FinTracka when an update is required.
- Repository documentation gives the exact inspected action list.
- After physical-device verification, export the Shortcut, sign it for **Anyone** with Apple's `shortcuts sign` command, and host the signed file or its iCloud share link behind an **Install/update scanner** button.
- The Shortcut contains no fixed environment URL or permanent secret; each run still receives its one-use session from FinTracka.
- Old numbered copies are not invoked. They can be removed manually after the canonical Shortcut passes both-phone acceptance.

## Failure and recovery

- Empty OCR: stop locally and do not upload or queue.
- Invalid model JSON: upload raw OCR with an empty model result; FinTracka requests refinement and still offers manual review.
- Network interruption: replay the same token, idempotency key, and body during the original session.
- iCloud unavailable: show that manual review is ready and that automatic refinement was not queued; never report success falsely.
- Mac asleep/offline: keep the package pending.
- Missing package after a D1 job exists: fail safely with `PACKAGE_NOT_FOUND`; do not fabricate a receipt.
- Helper/model unavailable: retry later, retain for seven days, and expose manual review.
- Successful Mac result: update idempotently, delete the pending package, and retain no image copy.
- Repeated failure for seven days: move the package to `failed`, show it in review, and let the member delete or retry it.

## Security and privacy boundaries

- The Shortcut uses only On-Device **Use Model**; Cloud, Private Cloud Compute, and ChatGPT choices are not allowed.
- Original images leave the phone only for the approved private shared iCloud folder when refinement is required.
- The public route accepts only one-use, member-bound tokens and bounded text; it never accepts images.
- Queue filenames and manifests reveal no household or financial information beyond the fact that an opaque receipt job exists.
- The Mac Access secret remains in Keychain and never enters iCloud, D1, logs, the Shortcut, or source control.
- Receipt/model output is untrusted. Evidence checks, arithmetic checks, strict schemas, and human review prevent prompt text or hallucinations from becoming financial data.
- All money uses integer cents. Nothing is matched or applied to the ledger automatically.

## Acceptance gates

Automated gates:

- v1 compatibility and v2 schema/size/replay/member-isolation tests;
- evidence tests proving unsupported values are removed;
- exact-cent arithmetic tests for subtotal, discounts, tax, tip, fees, and total;
- prompt-injection fixtures proving receipt text cannot change contracts or destinations;
- refinement claim/lease/idempotency/expiry tests;
- queue retention and successful-deletion tests;
- Swift fixture tests for structured Vision/model output, including model-unavailable behavior;
- frontend tests for accepted, needs-review, pending-refinement, failed-refinement, retry, edit, and delete states.

Physical-device gates on both phones:

- camera and photo-library capture;
- one page, six pages, long overlap, crumpled/faded receipt, photographed checkout screen, and cancellation;
- On-Device model selected with airplane-mode recognition before upload;
- the private acceptance receipts recover every visible priced line and summary amount or visibly flag the specific unsupported field;
- automatic iCloud queue on an intentionally unreconciled scan;
- Mac-off pending state, Mac-on refinement, browser refresh to refined draft, and package deletion;
- zero empty drafts and zero duplicate drafts.

Production remains gated until the exact production Worker route, D1 migration, signed canonical Shortcut, both-phone matrix, Mac LaunchAgent, and one user-reviewed live receipt all pass.

## Deliberate exclusions

- No Windows/iCloud Photos OCR worker.
- No paid OCR or hosted LLM fallback.
- No App Store application.
- No general-purpose image upload API.
- No automatic bank matching or ledger mutation.
- No model-based category assignment in this feature.

These exclusions keep the implementation focused and preserve the option to replace the Shortcut with a native iOS client later without changing the validated receipt or refinement contracts.
