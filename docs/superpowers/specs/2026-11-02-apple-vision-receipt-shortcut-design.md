# Apple Vision Receipt Shortcut Design

**Date:** November 2, 2026  
**Status:** Approved direction; implementation plan requested  
**Supersedes:** The production OCR portion of `2026-10-31-mobile-receipt-scanning-design.md` and `2026-11-01-receipt-ocr-accuracy-design.md`  
**Preserves:** Existing receipt review, reconciliation, matching, Mac validation, and exact-once ledger application

## Intent

Replace the unstable iPhone Safari WebAssembly OCR step with Apple's native on-device text recognition while keeping the rest of receipt processing in FinTracka. A person starts from FinTracka, briefly enters an iPhone Shortcut to photograph or select receipt pages, and returns automatically to a populated FinTracka review screen.

The result must remain free, private, and reliable on the current iPhones. Receipt photographs stay on the phone. Only recognized text crosses the network. A failed scan must not create another empty receipt draft.

## Goals

- Use the iPhone's Apple Vision-backed **Extract Text from Image** Shortcut action instead of browser WebAssembly OCR.
- Support camera and photo-library input, one or more pages, and long receipts photographed in overlapping sections.
- Return automatically to FinTracka with merchant, date, totals, and item lines ready for review.
- Reuse the existing `receipt_draft/v1`, exact-cent reconciliation, ownership, classification, matching, and Mac command flow.
- Keep scan authorization short-lived, one-time, member-scoped, and revocable without storing a permanent FinTracka credential inside the Shortcut.
- Never create an empty draft when recognition, upload, parsing, or navigation fails.
- Let David or Ariela dismiss eligible receipt drafts directly from the Receipt Inbox.
- Preserve the existing review correction path for unreadable or unusual receipts.

## Non-goals

- Building or distributing a native App Store application.
- Uploading receipt photographs to Cloudflare, the Mac, Apple, or a third-party OCR service.
- Treating OCR output as financial truth or automatically matching a bank transaction.
- Replacing the existing review and exact-cent validation requirements.
- Claiming Vision exposes bounding boxes or confidence through Shortcuts; the Shortcut provides ordered recognized text only.
- Keeping the current PaddleOCR browser engine as a user-facing fallback on iPhone.

## Approaches considered

### 1. Apple Vision through an iPhone Shortcut — selected

FinTracka issues a ten-minute, single-use scan session while the member is authenticated in Safari. It opens a generic Shortcut with that session as input. The Shortcut captures or selects images, performs native text recognition locally, sends recognized page text to one tightly bounded Worker endpoint, then opens the returned FinTracka review URL.

This is free, avoids Safari's WebAssembly memory failures, uses the iPhone's optimized OCR, and does not place a reusable cloud credential in the Shortcut. The tradeoff is a brief handoff to Shortcuts and text-only layout information.

### 2. Lower-memory browser OCR — rejected for production

Smaller images, tiles, or a smaller model could reduce crashes, but would weaken recognition on faded and narrow receipt text and would remain vulnerable to Safari memory pressure.

### 3. Native iOS companion — deferred

A Swift/Vision app could provide the best seamless capture and bounding boxes, but adds signing, distribution, and a separately maintained client. The contracts below remain usable by a future native app.

## User flow

1. In FinTracka, open **Transactions → Receipts → Scan a receipt**.
2. FinTracka prepares a ten-minute one-use scan session and displays **Scan with iPhone**.
3. Tap the button. The installed `FinTracka Scan Receipt` Shortcut opens.
4. Choose **Take photos** or **Choose from photo library** and select one or more pages.
5. The Shortcut applies **Extract Text from Image** to each page. Photos and OCR execution remain on the iPhone.
6. The Shortcut sends a page-ordered JSON array of recognized text to the exact receipt-import endpoint.
7. The Worker validates and consumes the one-time session, stores the recognized text as a short-lived import, and returns an Access-protected review URL.
8. The Shortcut opens that URL. Safari may ask for the normal Cloudflare Access login if its session expired.
9. FinTracka converts the ordered text to receipt observations, runs the existing parser and arithmetic checks, creates one normal receipt draft idempotently, deletes the temporary import, and opens the normal receipt review screen.
10. The user corrects anything uncertain and continues through the existing save and matching flow.

Cancellation or failure leaves no receipt draft. The scan session and any unclaimed import expire automatically.

## Authentication and handoff

### Browser-issued scan session

The normal Access-authenticated browser creates a scan session using `POST /api/v1/mobile/receipt-scan-sessions`. The Worker stores only a SHA-256 digest of a random 256-bit token, bound to the authenticated household member, with a ten-minute expiry. The plaintext token is returned once and held only in page memory and the Shortcut invocation input.

### Shortcut upload endpoint

The exact path `/api/v1/mobile/shortcut/receipt-imports` is the only route made public through a Cloudflare Access `public` destination override on the existing Viewer application. Destination override path patterns do not implicitly cover subpaths. Access cannot restrict that override by HTTP method, so the Worker accepts only `POST` and rejects every other method. The path remains application-authenticated: `POST` requires the one-time bearer token, strict JSON, a bounded body, and a valid session. The Worker consumes the token atomically when it creates the import.

The Access configuration must expose only this exact path—not `/api/v1/mobile/shortcut/*`, `/api/v1/mobile/*`, or the Worker hostname generally. Every other API and page remains under the existing Access applications.

After first success, the same token, idempotency key, and canonical body digest may replay the same import until the session expires so a lost HTTP response is recoverable. Any different idempotency key or body presented with that consumed token is rejected. The session row records only the token digest, consumed import ID, idempotency key, and body digest—not the plaintext token.

This design deliberately avoids a permanent Access service-token secret inside an iCloud-synced Shortcut.

## Contracts

### Scan session response

```json
{
  "contract": "receipt_scan_session/v1",
  "token": "<returned once>",
  "upload_url": "https://<viewer>/api/v1/mobile/shortcut/receipt-imports",
  "expires_at": "2026-11-02T12:10:00.000Z"
}
```

The frontend URL-encodes this object as the Shortcut's text input. It must never be logged, persisted to local storage, included in analytics, or placed in a normal HTTPS query string.

### Shortcut upload

```json
{
  "contract": "receipt_shortcut_capture/v1",
  "idempotency_key": "<uuid>",
  "shortcut_version": 1,
  "pages": [
    { "page_index": 0, "text": "recognized page text" }
  ]
}
```

The request uses `Authorization: Bearer <one-time-token>` and `Content-Type: application/json`. Limits are 12 pages, 30,000 Unicode characters per page, 100,000 characters total, and 128 KiB encoded JSON. Blank pages are rejected. The response contains only `import_id` and an HTTPS `review_url`; it never echoes recognized text.

### Temporary import

Temporary imports belong to one household and one member. They retain recognized page text for at most 30 minutes. The matching Access-authenticated member can retrieve the import and delete it; another household member cannot claim it. Import identifiers are opaque UUIDs and are not credentials. Session issuance is limited to 10 sessions per member per hour, and each member may have at most 5 active temporary imports.

## Text-to-receipt adaptation

Apple's Shortcut action returns ordered text without OCR polygons or numeric confidence. FinTracka therefore creates conservative synthetic observations:

- normalize Unicode spaces and line endings without changing visible characters;
- preserve page and line order;
- place one normal line per synthetic visual row;
- pair a text-only line followed immediately by a money-only line onto the same synthetic row;
- assign conservative confidence below the automatic-confidence threshold so imported items remain visibly reviewable;
- retain the existing duplicate-page and overlap checks where ordered text provides enough evidence;
- use the existing merchant, date, summary, item, and arithmetic parser after adaptation.

The adapter never invents missing prices or descriptions. If no merchant, total, or priced item can be derived, the import page shows the recognized text and offers retry or discard; it does not create an empty draft.

## Storage and lifecycle

Two new D1 tables hold scan sessions and temporary imports. Session rows contain token digests, member ownership, timestamps, and usage state—never plaintext tokens. Import rows contain recognized page text and expire after 30 minutes. Cleanup runs opportunistically during session creation, upload, and import retrieval.

The normal structured receipt draft remains governed by the existing 90-day retention and receipt revision model. Images remain only in Photos/Camera/Shortcuts memory and are never stored by FinTracka in this phase.

## Receipt Inbox removal

Eligible `editing`, `waiting_for_bank`, and `conflict` drafts show an accessible remove button. Removal requires a confirmation and calls the existing optimistic-revision dismissal endpoint. `match_pending`, `processing`, and `matched` drafts cannot be removed from the inbox. A conflict refreshes the row instead of silently hiding it.

## Shortcut contents

The generic Shortcut contains no FinTracka secret. It:

1. reads its JSON text input;
2. verifies the session contract and expiry;
3. asks for camera or photo-library input;
4. accepts up to 12 images;
5. runs **Extract Text from Image** once per image;
6. builds the capture JSON in page order;
7. POSTs it with the supplied one-time bearer token;
8. opens the returned `review_url`;
9. shows a clear local error; images remain available only within the current Shortcut run, and a later run asks the user to reselect or retake them.

The setup guide covers installation on both David's and Ariela's phones, displays the required Shortcut version in FinTracka, and explains how to replace an older version. If the custom URL scheme cannot open the Shortcut, FinTracka returns to an install/help state rather than leaving a false draft.

The repository stores a precise setup guide and screenshots/action names, not a Shortcut file containing environment-specific URLs or credentials.

## Failure behavior

- Expired or consumed session: show **Return to FinTracka and start a new scan**; no draft is created.
- No recognized text: stop locally before upload.
- Invalid/oversized upload: safe error code only; no import or draft.
- Network interruption: the same token, idempotency key, and canonical body may retry while the session remains valid; a successful replay returns the same import, while any changed replay is rejected.
- Access login expired on return: authenticate normally, then continue the opaque review URL.
- Parser finds no usable receipt facts: show raw recognized text in the member-protected import page with retry/discard actions; no empty draft.
- Draft creation succeeds but import deletion fails: await deletion inside a guarded cleanup, navigate to the created draft regardless, and have a later deterministic replay reopen the same draft and retry cleanup.

## Deployment and acceptance gates

1. Unit and integration tests pass locally for both frontend and Worker.
2. Staging Worker is deployed with only the exact public Access path override.
3. A staging Shortcut scans camera and library images, returns to the correct member, and cannot replay its token.
4. The supplied private receipt set is tested on a real iPhone. Every scan must avoid Safari reloads and exactly recover the expected merchant, every visible summary amount, and every visible priced line. If deterministic text-order parsing cannot meet that bar, the Shortcut approach does not ship as the production replacement.
5. Multi-page and duplicate-photo cases create one draft with no silent double counting.
6. Empty/failed scans create zero drafts, and the inbox remove control dismisses the existing empty drafts.
7. With the phone in airplane mode and a photo already stored locally, **Extract Text from Image** completes before any upload attempt; this verifies the on-device OCR privacy claim on the actual iOS version.
8. Both household phones install the same reviewed Shortcut version and complete one member-isolated scan.
9. Only after the staging record is written in `docs/receipt-processing-runbook.md` may the exact production path override and frontend be deployed.

The old browser OCR code may remain temporarily available only to the private development benchmark during rollout. It is removed in a later cleanup after the Shortcut passes the real-device acceptance set; it is not offered in the production iPhone UI.
