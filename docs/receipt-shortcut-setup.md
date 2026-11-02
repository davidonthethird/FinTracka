# FinTracka Scan Receipt Shortcut

This is the reviewed version-1 recipe for the generic **FinTracka Scan Receipt** iPhone Shortcut. It performs OCR with Apple's on-device **Extract Text from Image** action. Receipt photos remain in Camera/Photos/Shortcuts memory; FinTracka receives only ordered recognized text.

The Shortcut contains no FinTracka hostname, reusable bearer token, Cloudflare credential, household identity, receipt text, analytics action, or logging action. Safari supplies a ten-minute one-use session every time it launches the Shortcut. Do not share an installed copy that has been modified to contain any of those values.

## Build version 1

Create a new shortcut named exactly `FinTracka Scan Receipt`. In its Details, accept **Text** as input and turn off Share Sheet exposure unless you intentionally want it. Add the actions below in order. Names can vary slightly by iOS release; use the action with the described input and output.

1. **Get Dictionary from Input** using `Shortcut Input`. Save as `Session`.
2. **Get Dictionary Value** `contract` from `Session`. If it is not exactly `receipt_scan_session/v1`, show `Open FinTracka and start a new receipt scan.` and stop.
3. Get `token`, `upload_url`, and `expires_at` from `Session. Validate that all three are non-empty. The upload URL must start with `https://` and end exactly in `/api/v1/mobile/shortcut/receipt-imports`; otherwise show the same safe error and stop.
4. **Get Dates from Input** for `expires_at`, then **Current Date**. If the expiry is not later than the current date, show `This scan expired. Return to FinTracka and start again.` and stop.
5. Set Number variable `ShortcutVersion` to `1`.
6. **Choose from Menu** with `Take photos` and `Choose from photo library`:
   - **Take photos:** **Ask for Number** with prompt `How many receipt pages?`, default `1`. If outside 1–12, show `Choose between 1 and 12 pages.` and stop. **Repeat** that count, running **Take Photo** once per repeat with the rear camera and preview enabled. Add each image to variable `Images` in capture order.
   - **Choose from photo library:** **Select Photos**, with `Select Multiple` enabled. Save the ordered result as `Images`.
7. **Count** `Images`. Stop with `Choose between 1 and 12 receipt photos.` unless the count is 1–12.
8. Set Number variable `PageIndex` to `0`. Create empty List variable `Pages`.
9. **Repeat with Each** item in `Images`, in order:
   - **Extract Text from Image** using `Repeat Item`.
   - Convert the result to Text and trim whitespace. If empty, show `No text was recognized on page [PageIndex + 1]. Retake or reselect that page.` and stop before any upload.
   - Create a Dictionary with `page_index` = `PageIndex` and `text` = recognized text. Add it to `Pages`.
   - Increment `PageIndex` by 1.
10. **Generate UUID** and save it as `IdempotencyKey`. Keep this value unchanged if **Get Contents of URL** is retried during this same Shortcut run.
11. Create Dictionary `Capture` with:
    - `contract`: `receipt_shortcut_capture/v1`
    - `idempotency_key`: `IdempotencyKey`
    - `shortcut_version`: `ShortcutVersion`
    - `pages`: `Pages`
12. **Get Contents of URL**:
    - URL: `upload_url` from `Session`
    - Method: `POST`
    - Headers: `Authorization` = `Bearer ` followed immediately by `token`; `Content-Type` = `application/json`
    - Request body: JSON = `Capture`
13. Get `review_url` from the response dictionary. Require an `https://` URL on the same host as `upload_url`. If absent or invalid, show `The text could not be handed back to FinTracka. Try this same run again while the session is still active.` and stop.
14. **Open URLs** with `review_url`.

Do not add **Quick Look**, **Show Result**, clipboard, Files, Notes, Messages, email, analytics, or third-party actions for tokens, response bodies, or recognized text. Camera and Photos permissions should be requested only when their respective menu branch runs.

## Install and inspect

Build the Shortcut once on a staging phone, then inspect every action from top to bottom. Confirm:

- the name is exactly `FinTracka Scan Receipt` and the local version is 1;
- there is no fixed URL, Access client ID/secret, bearer token, household email, or receipt text;
- the sole network action uses the session-provided HTTPS URL and one-time token;
- there is no analytics, clipboard, share, log, or cloud-storage action;
- camera and library paths both preserve page order and reject page 13;
- rerunning from FinTracka creates a new session rather than reusing an old Shortcut input.

Install the same inspected Shortcut on David's and Ariela's phones. To update, delete or rename the old copy first, install/build the reviewed copy, confirm its exact name, and run a staging camera and library test. If FinTracka reports that Shortcuts cannot find it, open the Shortcuts app, confirm the exact name, run it once manually to accept permissions, return to FinTracka, and start a new scan. Never repair this by hard-coding the upload URL or token.

Screenshots may be added to a private operating record only after redacting tokens, URLs containing account-specific hostnames, Access identifiers, household identity, and all receipt text. Do not commit those screenshots.

## Cloudflare staging gate

The Worker feature remains off until this gate passes.

1. Apply D1 migration `0005_receipt_shortcut_imports.sql` twice in staging; the second run must report no pending migrations.
2. Deploy the staging Viewer with `FEATURE_RECEIPT_SHORTCUT=false`.
3. In **Zero Trust → Access → Applications**, add a separate self-hosted application for the staging Viewer hostname with path exactly `/api/v1/mobile/shortcut/receipt-imports`. Do not use a wildcard, parent path, query string, or neighboring path.
4. Add one **Bypass / Everyone** policy to that exact-path application. Cloudflare Access Bypass removes Access authentication and logging for the matching path, so the Worker one-time token is the only application credential there. The general Viewer Access application must continue protecting every other path.
5. Confirm the exact-path application wins over the parent application. Unauthenticated `GET`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS` requests to the exact endpoint must reach the Worker and return `405`; only a valid token-bearing `POST` can create an import. `/api/v1/mobile/shortcut/`, `/api/v1/mobile/shortcut/receipt-imports/anything`, `/api/v1/mobile/receipt-imports/...`, and all Viewer pages must still require Access.
6. Enable `FEATURE_RECEIPT_SHORTCUT=true` in staging only and deploy again.
7. Run the matrix below, then one camera and one library scan for each household member. Each import must be visible only to the member who created its session.

Cloudflare documents that the more-specific application path takes precedence and that Access application paths do not support query strings. Bypass is intended only for narrowly public endpoints and disables Access enforcement for matching traffic, which is why this application must contain the exact path only.

## Required staging matrix

Record only pass/fail, timestamp, Worker version, and redacted status/error code outside source control. Never record a real token or recognized receipt text.

| Test | Required result |
|---|---|
| `POST` without bearer token | `401 RECEIPT_SCAN_SESSION_INVALID` |
| malformed or wrong token | `401`, no details or redirect |
| expired token | `401 RECEIPT_SCAN_SESSION_EXPIRED` |
| first valid token/body/key | `201`, opaque import ID and HTTPS review URL |
| same token + same key + same body | `200`, same import ID |
| same consumed token + changed key/body | `409 RECEIPT_SCAN_SESSION_CONSUMED` |
| non-`POST` on exact public path | `405`, `Allow: POST` |
| body over 128 KiB | `413`, no import |
| invalid contract, blank page, >12 pages, >100k characters | `400`, no import |
| neighboring path without Access session | Access login/denial; never Worker JSON |
| other household member retrieves opaque import ID | `404` or `403`, no text |
| valid owner retrieves import | `200`, ordered pages only |
| valid owner deletes import | `204`; later GET is `404` |
| camera and photo-library runs | populated review screen; zero image upload |

## Rollback

1. Set `FEATURE_RECEIPT_SHORTCUT=false` and redeploy. The scan-session, upload, and import APIs then fail closed while existing receipt drafts/review/matching continue normally.
2. Remove only the exact-path Access application or its Bypass policy. Do not alter the parent Viewer or Mac applications.
3. Revoke outstanding sessions/imports by deleting rows from `receipt_shortcut_imports` and `receipt_scan_sessions` in the intended environment after recording row counts—not contents. These tables hold temporary recognized text, so do not export them.
4. Verify the exact upload path again requires Access and neighboring paths are unchanged.
5. Leave migration `0005` in place; do not reverse D1 migrations in production.

The browser PaddleOCR benchmark remains available only on the private development route during acceptance. Production builds contain neither its code nor OCR model/runtime assets.

## Primary references

- [Apple: run a shortcut using a URL scheme on iPhone or iPad](https://support.apple.com/en-au/guide/shortcuts/apd624386f42/ios)
- [Apple: understanding Shortcut input types](https://support.apple.com/en-gb/guide/shortcuts/apd7644168e1/ios)
- [Cloudflare: Access application paths and precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [Cloudflare: Access Bypass policy behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
