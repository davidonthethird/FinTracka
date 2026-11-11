# iCloud Receipt Handoff Design

**Date:** November 11, 2026
**Status:** Approved for implementation planning
**Supersedes:** The Shortcut-to-Worker upload and Mac model-refinement portions of `2026-11-04-apple-receipt-hybrid-design.md`
**Preserves:** Apple Vision capture, on-device versus Private Cloud Compute comparison, evidence validation, exact-cent arithmetic, temporary receipt review, transaction matching, and member isolation

## Intent

Remove the failure-prone URL, JSON, and clipboard handoff from the iPhone Shortcut. The iPhone will photograph or select receipt pages, recognize each page, run both Apple model routes, and save one bounded package to the private iCloud folder shared by David and Ariela. The existing Mac process will only validate and relay that package to FinTracka. It will not run either comparison model.

This design deliberately reuses the existing receipt comparison, validation, Mac Access identity, once-per-minute scheduler, review screen, and private iCloud queue. It adds no paid service, hosted model, reusable phone credential, or new daemon.

## End-to-end flow

1. An authenticated member opens **Scan receipt**. FinTracka creates a seven-day opaque `handoff_id` bound to that member and starts polling its authenticated status.
2. FinTracka launches the canonical **FinTracka Receipt Scanner** with only the package contract and `handoff_id`. No bearer token, upload URL, Access credential, or household identity is passed to the Shortcut.
3. The Shortcut selects or photographs 1–12 ordered pages.
4. A **Repeat with Each** loop runs **Extract Text from Image** once per page and combines the results with explicit page markers. A blank page remains visible as blank; it is not silently dropped.
5. The same combined OCR text and fixed receipt prompt are sent once to **Use Model → On Device** and once to **Use Model → Private Cloud Compute**. Each route records a bounded result, status, and measured duration.
6. The Shortcut saves the ordered pages and four small UTF-8 text files into `FinTracka Receipt Queue/pending/<handoff-id>/`. It writes `manifest.txt` last. It does not call **Get Contents of URL**, open a callback URL, use the clipboard, or serialize model text into JSON.
7. The existing Mac LaunchAgent sees a complete package, validates it, and checks that the `handoff_id` is still active. If phone OCR is blank, the existing Swift helper may run Apple Vision in explicit OCR-only mode. The Mac never runs Foundation Models for this path.
8. The Mac assembles the already-supported `receipt_shortcut_capture/v3` body and submits it to a new Mac-Access-protected completion endpoint. The Worker reuses the existing v3 schema, comparison, benchmark, and receipt validation code.
9. The Worker completes the handoff exactly once, creates the temporary receipt import, and makes its review path available to the authenticated member. The open scan page navigates automatically; a member who returns later can open the queued/completed scan from the receipt inbox.
10. After an idempotent success response, the Mac deletes the iCloud package. Retryable failures keep it pending. Terminal invalid packages move to `failed` and are removed after seven days.

If the Mac is asleep, the package simply waits. The browser may be closed without losing the scan.

## Trust boundaries

- Apple Vision and both comparison model routes run on the iPhone/Apple infrastructure selected by the Shortcut.
- The private iCloud folder is shared only between David and Ariela. Receipt photos, OCR, and both model outputs exist there temporarily and are deleted after successful relay.
- The Mac has the only persistent FinTracka service credential, stored in Keychain. That credential never enters the Shortcut, iCloud, D1, logs, or source control.
- `handoff_id` is an opaque locator, not an authorization secret. Completing a handoff requires the Mac Access identity. Reading status or results requires the authenticated, owning FinTracka member.
- Cloudflare/D1 receives text and structured model results only, never receipt images.
- Receipt and model text are untrusted data. Existing strict schemas, exact evidence checks, integer-cent arithmetic, and human review remain authoritative.

## Contracts

### Browser session

`POST /api/v1/mobile/receipt-scan-sessions` advertises Shortcut recipe version 4 and returns:

```json
{
  "contract": "receipt_queue_handoff/v1",
  "shortcut_version": 4,
  "shortcut_name": "FinTracka Receipt Scanner",
  "comparison_enabled": true,
  "handoff_id": "opaque UUID",
  "expires_at": "ISO timestamp"
}
```

The browser launches the Shortcut with only `contract` and `handoff_id`. The legacy v1–v3 upload route remains during rollout but is not used by version 4.

Authenticated status responses are `pending`, `processing`, `ready` with a `review_path`, or `failed` with a safe error code. Active handoffs are listed for the owning member so a completed scan remains discoverable after the original tab closes.

### iCloud package

```text
FinTracka Receipt Queue/
  pending/<handoff-id>/
    page-001.heic
    ...
    ocr.txt
    on-device.txt
    private-cloud-compute.txt
    manifest.txt       # written last; readiness marker
  failed/<handoff-id>/...
```

`manifest.txt` is strict UTF-8 `key=value` data with no free-form model output:

```text
contract=receipt_queue_capture/v1
handoff_id=<UUID>
page_count=<1..12>
created_at=<ISO-8601>
on_device_status=completed|unavailable|rate_limited|failed
on_device_duration_ms=<nonnegative integer>
private_cloud_compute_status=completed|unavailable|rate_limited|failed
private_cloud_compute_duration_ms=<nonnegative integer>
```

Rules:

- `manifest.txt` is written only after every other file is closed.
- `ocr.txt` is at most 100,000 UTF-8 characters. It may be blank only so the Mac can attempt OCR-only Apple Vision recovery.
- A `completed` model status requires a nonblank matching model file of at most 100,000 characters. Other statuses require an empty model file.
- Pages are nonempty regular HEIC/JPEG image files, at most 20 MiB each and 100 MiB total, matching the existing queue limits.
- The directory contains exactly the declared files; symlinks, aliases, traversal, extra files, malformed Unicode, or changed names are rejected.
- A missing or incomplete package is ignored during iCloud's settling window rather than failed or deleted.

Separate files are intentional: model output can contain arbitrary quotes and newlines, while the manifest never interpolates it.

### Worker handoff state

A new `receipt_queue_handoffs` row binds one UUID to the originating scan session, household, member, status, completion digest, optional import ID, and seven-day expiry. The legacy public upload token stays short-lived and never enters iCloud.

Mac-only endpoints protected by the existing Access service identity:

- `GET /api/v1/mobile/mac/receipt-queue-handoffs/active` returns bounded active opaque IDs.
- `POST /api/v1/mobile/mac/receipt-queue-handoffs/{id}/complete` accepts one strict v3 capture.

Completion is idempotent for the same canonical body digest and rejects a changed replay. The completion path calls the same internal import routine as the legacy upload; it does not duplicate validation or benchmark logic. Queue-created imports remain reviewable for seven days.

## Mac behavior

The existing `com.fintracka.mobile-commands` LaunchAgent remains the only scheduler and continues running at login and once per minute while the Mac is awake.

For each run it:

1. retrieves the bounded active handoff IDs with the existing Access client;
2. examines at most three ready packages serially;
3. waits for all exact files to be present and stable before validation;
4. validates package paths, sizes, UTF-8 text, manifest fields, and handoff membership;
5. uses phone OCR unchanged, or invokes `fintracka-receipt-refiner --ocr-only <package>` only when it is blank;
6. converts the two saved model results/statuses into the existing v3 capture without interpreting them;
7. completes the handoff using an idempotency key derived from the validated package;
8. deletes the package only after confirmed or replay-confirmed success.

The OCR-only helper returns recognized page text and cannot initialize or call Foundation Models. Phone model outputs remain the comparison candidates even when the Mac supplies fallback OCR.

## Failure and recovery

- **Mac asleep/offline:** keep the package pending for seven days; the inbox shows `Waiting for Mac`.
- **iCloud partially synchronized:** ignore until the exact package is complete and stable; never delete it as invalid during settling.
- **Lost completion response:** retry the identical body; Worker returns the existing import.
- **Changed replay:** reject it and retain the package for inspection.
- **Blank phone OCR:** run Mac Vision OCR-only; if still blank, mark the handoff failed with a safe code and keep the package in `failed` for seven days.
- **One Apple model unavailable:** store that route's typed status and preserve the other route. The comparison screen shows the missing route rather than fabricating output.
- **Both Apple models unavailable:** import OCR for manual review and mark both routes unavailable.
- **Browser closed:** the member's authenticated active-handoff list shows pending/completed scans on return.
- **Expired handoff:** Mac moves the corresponding package to `failed`; retention removes it after seven days.
- **Delete failure after completion:** an identical replay confirms completion before a later cleanup attempt. No duplicate import is created.

## Compatibility and rollout

- Legacy v1–v3 Shortcut imports stay enabled until version 4 passes production acceptance on both phones.
- Version 4 is feature-flagged independently for session advertisement, Mac completion, and UI listing.
- Deployment order is migration, Worker support, Mac processor/helper, viewer, signed Shortcut, then version-4 advertisement.
- Rollback stops advertising version 4 but leaves Worker/Mac support active until every pending package has completed or expired.
- Only one canonical Shortcut remains after acceptance; numbered copies are removed from both phones.

## Acceptance gates

Automated:

- D1 member isolation, expiry, listing, exact-once completion, and changed-replay rejection;
- strict package parsing, partial-iCloud settling, symlink/traversal/size/UTF-8 rejection, retry, retention, and deletion-after-success;
- explicit Swift OCR-only tests proving Foundation Models are not initialized;
- v1–v3 compatibility and v4 browser polling/listing tests;
- Shortcut plist validation, signing, nonzero archive, action audit proving there is no URL/network/clipboard action, and a per-page OCR loop;
- full remote, frontend, Python, Swift, typecheck, build, deployment check, and `git diff --check` gates.

Physical on both David's and Ariela's iPhones:

- camera and photo-library input;
- one page, multi-page, long, crumpled/faded, photographed-screen, and cancellation cases;
- both on-device and Private Cloud Compute outputs plus measured durations reach the comparison UI;
- Mac awake, Mac asleep then awakened, lost-network retry, and browser-close/reopen paths;
- blank-OCR fallback visibly uses only Mac Vision;
- no Safari callback, `Get Contents of URL`, clipboard, empty receipt, duplicate import, or orphan package;
- successful package deletion and one user-reviewed live receipt.

Production is not accepted until those real-device gates pass. Automated Shortcut validation alone is not evidence of iOS runtime behavior.

## Deliberate exclusions

- No Mac Foundation Models comparison route.
- No Windows worker, paid OCR, hosted LLM, generic image upload, or new daemon.
- No automatic transaction match or ledger mutation.
- No receipt images in Cloudflare/D1.
- No attempt to make `handoff_id` a credential.
