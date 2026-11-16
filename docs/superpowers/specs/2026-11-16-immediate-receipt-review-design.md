# Immediate Receipt Review Before Mac Verification — Design

**Date:** 2026-11-16
**Status:** Approved for implementation planning

## Problem

The current receipt queue waits for the Mac to relay an iCloud package before FinTracka creates a reviewable receipt. That protects the receipt photos, but it unnecessarily blocks David or Ariela from assigning each item to David, Ariela, or Shared even though Cloud Pro has already interpreted the receipt on the iPhone.

The desired order is:

1. Cloud Pro interprets the receipt on the iPhone.
2. FinTracka immediately opens the existing receipt editor.
3. David or Ariela assigns every item to David, Ariela, or Shared.
4. The Mac later verifies the private iCloud package.
5. Only a Mac-verified receipt can be matched to a bank transaction and affect spending.

## Approved Architecture

Use the existing one-time scan session, receipt import validator, receipt draft editor, owner controls, private iCloud queue, and Mac processor. Do not create another receipt editor or a second receipt ledger.

The Shortcut performs two outputs from the same Cloud Pro result:

- It saves the existing private iCloud package, including receipt photos, OCR text, Cloud Pro result, durations, and manifest. Photos never go to FinTracka.
- It sends only OCR text plus the structured Cloud Pro result to FinTracka through the existing one-time receipt upload endpoint.

The direct upload makes the receipt immediately reviewable. The private iCloud package remains the verification evidence and offline fallback.

```text
iPhone photos
  -> Apple Vision OCR + Cloud Pro
  -> private iCloud package (photos + text + result)
  -> one-time HTTPS upload (text + result only)
  -> existing FinTracka receipt draft editor
  -> David / Ariela / Shared assignment
  -> Mac verifies the private package
  -> transaction matching becomes available
```

## Session Contract

Introduce one canonical Shortcut contract for this flow:

```text
receipt_immediate_handoff/v1
<handoff UUID>
<43-character one-time session token>
```

The production upload endpoint is fixed in the signed Shortcut. The input contains no persistent credential and no receipt data. The token is member-bound, single-use, expires after 30 minutes for direct upload, and remains associated with the seven-day private queue handoff for Mac fallback.

The canonical Shortcut remains named `FinTracka Receipt Scanner`. Version 5 replaces version 4; numbered duplicate Shortcuts are not supported.

## State Model

The internal queue states become:

- `pending`: private handoff exists; no direct result is available yet.
- `reviewable`: the direct Cloud Pro result passed server validation and can be reviewed immediately.
- `processing`: the Mac claimed the private package for verification.
- `completed`: the Mac package produced the same canonical capture digest as the direct result, or the Mac created the import through the fallback path.
- `failed`: the private package is invalid, missing, unreconciled, or differs from the direct result.

The browser continues to expose a simple `pending`, `ready`, or `failed` navigation state. A separate verification status is shown on the receipt draft.

## Immediate Review

When the direct upload succeeds:

1. The Worker uses the existing strict `receipt_shortcut_capture/v2` schema and receipt interpretation validator.
2. It creates the existing temporary receipt import and marks the handoff `reviewable`.
3. The already-running browser poll navigates to the existing import page.
4. The import page creates the existing `receipt_draft/v1` draft and links that draft to the handoff before deleting the temporary import.
5. The existing receipt editor opens with every line initially Shared. The user can choose David, Ariela, or Shared and save.

The draft is visibly labeled “Waiting for Mac verification.” It remains editable, but it cannot be matched to a bank transaction and therefore cannot affect spending.

## Mac Verification

The Mac does not need to rerun the language model. It reads the private package exactly as it does today, rebuilds the canonical capture, and compares its digest to the digest accepted from the iPhone.

- Exact digest match: mark the linked draft verified and allow matching.
- No direct upload: preserve the existing fallback; the Mac creates the import and the browser reviews it afterward.
- Digest mismatch or invalid package: mark verification failed, keep the user's draft and owner assignments, block matching, and show a safe actionable error. Never silently overwrite assignments or amounts.

This makes Mac verification deterministic and avoids a line-merging system that is unnecessary for the approved flow.

## Security and Privacy Invariants

- Receipt photos remain in the private shared iCloud folder and never reach the FinTracka Worker or D1.
- The direct request contains only OCR text, Cloud Pro structured output, timing metadata, and idempotency data.
- The Shortcut contains no Cloudflare Access token, service token, API key, or other persistent secret.
- The direct endpoint accepts only the member-bound, one-time bearer session token.
- Request body size, exact JSON schema, content type, replay digest, expiration, member authorization, and rate limits remain enforced.
- A provisional draft cannot be matched, split into a transaction, or counted in planning/reporting.
- Mac verification never modifies owner selections.

## Failure and Recovery

- Direct upload fails after the iCloud package is saved: the current Mac relay path creates the receipt later.
- Browser is closed: the handoff remains listed in the receipt inbox; reopening FinTracka resumes the flow.
- The same upload is retried: the existing idempotency key and body digest return the same import.
- Mac processes the same package twice: completion is idempotent.
- Direct and private captures differ: fail closed with `CAPTURE_MISMATCH`; retain the provisional draft for inspection or dismissal.
- Mac remains offline: owner assignments stay saved, but matching remains disabled.

## User Interface

Reuse the current receipt pages and controls:

- Capture page: explain that the receipt is available for item assignment immediately and verified by the Mac later.
- Receipt editor: show a compact verification banner above the fields.
- Receipt inbox: distinguish “Ready to assign,” “Waiting for Mac verification,” “Verified,” and “Verification failed.”
- Match panel: replace the match controls with the verification status until the Mac completes.

No new navigation tab, separate editor, or new owner taxonomy is introduced.

## Rollout

1. Deploy the D1 migration and Worker changes with version 4 still accepted.
2. Deploy the viewer changes.
3. Build, validate, sign, and physically test version 5.
4. Replace the canonical Shortcut on David's iPhone, then Ariela's iPhone.
5. Keep the Mac fallback enabled throughout rollout.
6. After successful physical tests, remove obsolete version-4 setup text and numbered duplicate Shortcuts.

## Acceptance Criteria

- With the Mac off, an iPhone scan opens a reviewable receipt in FinTracka after Cloud Pro completes.
- The user can assign every line to David, Ariela, or Shared and those choices survive refresh and app reopen.
- The receipt cannot be matched or counted before Mac verification.
- With the Mac on, the existing one-minute processor verifies the same package and unlocks matching without changing owner choices.
- If direct upload is unavailable, the private iCloud package is still processed by the Mac and no receipt is lost.
- Camera and photo-library capture both work on a physical iPhone.
- Only one canonical `FinTracka Receipt Scanner` Shortcut remains installed.

## Explicit Non-Goals

- Uploading receipt photos to FinTracka.
- Rerunning Cloud Pro on the Mac.
- Automatically resolving a capture mismatch.
- Adding a new receipt editor, owner model, or financial ledger.
- Making provisional receipt data affect spending, savings, planning, or reports.
