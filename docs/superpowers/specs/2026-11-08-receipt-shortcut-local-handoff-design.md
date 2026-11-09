# Receipt Shortcut Local Handoff Design

## Intent

Keep receipt photos and Apple-model processing on the iPhone while reliably returning only recognized text and model results to FinTracka. The workflow must not trigger Apple's permission to send a receipt photo to FinTracka.

## Goals

- The Shortcut performs no network request and contains no upload URL.
- The Shortcut copies a versioned, text-only result envelope to the clipboard and tells the member to return to FinTracka.
- The authenticated FinTracka receipt page imports the envelope with one explicit tap, submits it same-origin, clears the clipboard, and opens the comparison screen.
- The one-time session token expires after thirty minutes so the sequential Apple model benchmark can finish; it remains single-use and binds the result to the correct member.
- Existing legacy Shortcut uploads remain accepted during migration.

## Non-goals

- Receipt images are never uploaded, cached, or stored by FinTracka.
- No new third-party service or dependency is introduced.
- This change does not alter receipt interpretation or model-selection logic.

## Constraints

- Clipboard data contains only the one-time token, OCR text, model JSON text, statuses, and durations.
- Clipboard imports are schema-validated, same-origin, size-limited, and rejected after expiry or reuse.
- The clipboard is cleared after a successful import.
- A failed or unrelated clipboard value must not consume the scan session.

## Approaches considered

1. **Direct Shortcut upload.** Fully automatic, but Apple retains photo-derived provenance and asks to send the photo. Rejected.
2. **URL-fragment callback.** Avoids a network action in Shortcuts, but realistic receipt/model results can exceed dependable URL lengths and may remain in browser history. Rejected.
3. **Short-lived clipboard handoff (selected).** One extra tap, but no image upload prompt, no URL-size limit, no third party, and straightforward validation and cleanup.

## Flow

1. FinTracka creates a private receipt scan session and launches the canonical Shortcut with its token.
2. The Shortcut selects photos, runs Vision OCR and both Apple model routes, builds `fintracka_receipt_handoff/v1`, and copies it to the clipboard.
3. The Shortcut displays “Return to FinTracka and tap Import scan results.”
4. The member returns to the already-open FinTracka receipt page and taps **Import scan results**.
5. FinTracka reads the clipboard under that user gesture, validates the envelope, submits it to a same-origin browser endpoint, clears the clipboard, and navigates to the existing model comparison.

## Success criteria

- No `Get Contents of URL` action or upload URL exists in the installed Shortcut.
- A real iPhone run does not show a photo-upload permission prompt.
- A real receipt reaches the existing comparison screen after the import tap.
- Automated frontend, Worker, privacy, validator, build, and end-to-end checks pass.
