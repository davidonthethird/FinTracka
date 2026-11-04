# Receipt processing runbook

FinTracka uses Apple's on-device text recognition and Apple Intelligence through the reviewed `FinTracka Receipt Scanner` iPhone Shortcut. The first pass uploads only recognized text plus evidence-citing structured fields through a ten-minute, one-use, member-bound session. Only a scan that fails deterministic evidence/arithmetic validation places its original pages in the private shared iCloud queue for Apple Vision and Foundation Models refinement on David's Mac. D1 never stores images. A reviewed structured draft is stored in household D1, and SQLite on the Mac remains the financial system of record. Build and deploy the Shortcut only from [receipt-shortcut-setup.md](receipt-shortcut-setup.md).

## Security and correctness boundaries

- The browser must explicitly select a posted bank transaction. Matching is never automatic.
- The Worker accepts only a negative transaction with the exact total and currency, within seven calendar days, and the current `split_revision`.
- The command contains only IDs, revisions, and SHA-256 digests. It contains no merchant, item text, account name, or amount.
- The Mac fetches the immutable receipt revision with its dedicated Access service identity, recalculates the digest, and repeats all transaction eligibility checks.
- Receipt application, detailed splits, audit data, and the permanent command receipt commit in one SQLite transaction. A retried command is a no-op.
- D1 stores no images or full card numbers. Local browser images expire after 30 days; D1 drafts/revisions expire after 90 days. Permanent redacted applications remain in SQLite to guarantee replay safety.
- Refinement claims use five-minute leases and a per-claim secret digest. Imports waiting for refinement live for at most seven days; successful refinement resets review expiry to 30 minutes. Exact completion replay is allowed, but a wrong claim token, changed input digest, or changed result is rejected.
- Successful iCloud packages are deleted. Temporary iCloud/model failures retry in `pending`; terminal invalid packages remain in `failed` for seven days. The Mac compares UUID-named pending packages with live jobs so discarded/expired packages are removed without touching unrelated files.

## Safe deployment order

1. Create and verify a local SQLite backup. Keep the once-per-minute command processor disabled.
2. Build and test the Viewer against snapshot schemas 1, 2, and 3.
3. Apply D1 migrations through `0006_receipt_refinements.sql` in staging. Run the command again and require “no migrations to apply.”
4. Deploy the Viewer Worker with `FEATURE_RECEIPT_DRAFTS=false`, `FEATURE_RECEIPT_MATCHING=false`, `FEATURE_RECEIPT_SHORTCUT=false`, and `FEATURE_RECEIPT_REFINEMENT=false`.
5. Migrate a copied/synthetic SQLite database through migration 021 and require `PRAGMA foreign_key_check` to return no rows.
6. Publish a synthetic snapshot v3. Verify older snapshots still read and v3 advertises `transaction.apply_receipt_split:[1]` and `receipts.matching:[1]`.
7. Build/install the native refiner, verify Apple Intelligence availability, and enable the existing one-minute mobile-command LaunchAgent. Enable drafts and `FEATURE_RECEIPT_REFINEMENT` in staging only. Configure and test the exact receipt-upload Access path, then enable `FEATURE_RECEIPT_SHORTCUT` in staging and run the iPhone gate below. Keep financial matching false.
8. Enable matching in staging and complete the controlled synthetic reconciliation.
9. Repeat migrations, reader deployment, and idempotence checks in production with both flags false.
10. Enable production drafts only after the iPhone gate. Enable production matching and the minute processor only after the user-selected live reconciliation.

## Required iPhone gate

On each supported household iPhone in the protected staging Viewer, install the inspected canonical version-2 Shortcut and use the normal camera and library flows:

- one page completes without Safari OCR or a page reload;
- six ordered pages return without duplicate or missing lines;
- the Shortcut performs **Extract Text from Image** and **Use Model → On-Device** before its upload attempt;
- a passing scan makes no image upload or third-party request; only recognized text and evidence-citing fields reach the exact Worker path;
- a deliberately unreconciled scan writes one opaque package to the private iCloud queue and completes when the Mac wakes;
- a long overlap is either collapsed only when exact or visibly flagged for review;
- camera and photo-library permissions appear only when used, and a cancelled/failed scan creates zero drafts.

If this gate fails, keep both production receipt flags false. Do not substitute cloud OCR without a new privacy and threat-model review.

## Controlled reconciliation

The household user—not an agent—chooses a harmless receipt and its intended transaction.

1. Record the transaction ID, `split_revision`, current receipt/split/application/audit counts, and the current snapshot ID.
2. Review every item, owner, category, and subcategory. Confirm the item allocations equal the receipt total exactly.
3. Select the exact posted candidate and submit once.
4. Run one manual processor cycle. Verify one receipt, one application, the expected split count, an increment of exactly one split revision, exact signed split sum, and one fresh snapshot.
5. Run the processor again. Verify every recorded count and revision is unchanged.
6. For correction testing, edit into a new immutable receipt revision, explicitly resubmit against the latest split revision, and verify the prior receipt-created splits are replaced atomically rather than duplicated.
7. Test Mac-off pending behavior, restart recovery, command expiry, feature-flag rollback, and restoration of the pre-migration backup before enabling the minute schedule.

## Verification commands

```sh
./scripts/verify.sh
./scripts/verify-receipt-hybrid.sh
cd remote
npm run check:deployment
npm run check:deployment -- --require-mac-access
npm audit --omit=dev --audit-level=high
cd ../frontend
npm audit --omit=dev --audit-level=high
cd ..
.venv/bin/python -m pip_audit
git diff --check
```

The repository currently has two dated baseline test failures documented in the implementation ledger: the manual-cash October fixture uses today’s date, and one savings-goal refill expectation differs from the implemented $25,000 cap. Receipt-specific, remote, frontend, migration, snapshot, and native processor suites must be green independently; do not hide new failures behind those baselines.

## Rollback

1. Set `FEATURE_RECEIPT_REFINEMENT=false`, `FEATURE_RECEIPT_SHORTCUT=false`, and `FEATURE_RECEIPT_MATCHING=false` and redeploy. Remove only the exact receipt-upload public destination override from the Viewer Access application. Pending receipt commands remain inert when refinement is disabled.
2. Disable and remove the command schedule with the existing CLI commands.
3. Keep `FEATURE_RECEIPT_DRAFTS=true` only if capture/review should remain available; set it false to hide the entire receipt surface.
4. Do not reverse a D1 or SQLite migration in place. Restore the verified pre-migration SQLite backup if local rollback is necessary; D1 columns/tables may remain unused.
5. Never delete local command receipts before restoring an older database: they are the exact-once evidence.

The private shared iCloud folder is a transient refinement queue, not a receipt backup. It is the only approved image-cloud path and must not be reused as permanent storage.

## 2026-11-01 deployment evidence

- Staging D1 applied `0003` and `0004`; the second application reported no pending migrations.
- Production D1 applied `0003` and `0004`; the second application reported no pending migrations.
- Staging Viewer version: `74639ae2-de3e-4899-946f-a125ef8e686e`.
- Production Viewer version: `1ee1ac56-9bce-405d-ae0d-8a94f5dc1a37`.
- Both deployments have `FEATURE_RECEIPT_DRAFTS=false` and `FEATURE_RECEIPT_MATCHING=false`.
- Synthetic local migration reached schema 21 with an empty `PRAGMA foreign_key_check` result.
- Worker deployment configuration and separate Mac Access audience passed, at an estimated 1,440 indexed empty polls per day.
- Frontend and remote production-dependency audits reported zero vulnerabilities. Python audit reported zero known vulnerabilities after pinning `pyasn1==0.6.5`.

At that deployment, no live receipt was selected or applied. The iPhone performance gate and user-selected controlled live reconciliation remained deliberate activation gates, not implementation gaps.

## 2026-11-01 browser OCR benchmark evidence (superseded for production capture)

- Replaced Tesseract with self-hosted PaddleOCR.js 0.4.2 and pinned PP-OCRv6-small detection/recognition models after comparing both engines against the real photos. Model hashes are verified during the build and no OCR CDN fallback exists.
- The final cold Mac/headless-browser benchmark completed one prepared Target page in 7.0 seconds. The OCR chunk lazy-loads only on the scan route; ordinary Viewer startup no longer includes the roughly 10 MB OCR JavaScript chunk.
- All nine real HEIC photos—including glare, wrinkles, perspective, faint thermal print, a photographed checkout screen, and two views of one receipt—produced exact visible merchant/summary fields and exact monetary lines. The ACME pair collapsed to one 16-line receipt. Stop & Shop's three ambiguous final digits were corrected only after the printed subtotal proved the 12-cent reconciliation, and those lines remain marked for review.
- The Target photograph contains no visible purchase date; the parser correctly leaves it blank rather than inferring or inventing one.
- Four exact posted purchases were applied locally after timestamped SQLite backups: ACME $109.61 (16 detailed lines), Target $38.11 (one detailed line), Home Depot $23.89 (one detailed line), and Liquor Wine Warehouse $162.20 (four detailed lines). Each increased `split_revision` exactly once, reconciled to the signed transaction amount, passed `PRAGMA foreign_key_check`, and was unchanged by an identical replay. The same-day Lowe's and Stop & Shop receipts remain unmatched until their bank transactions post.
- iPhone Mirroring displayed the protected Viewer but macOS automation could not interact with the mirrored window. These results remain parser benchmark evidence only. Production capture now uses Apple Vision through the Shortcut, and its physical-iPhone gate remains required before activation.

## Apple Vision Shortcut activation evidence

Pending. Record the date, staging Worker version, exact-path Access application review, security-matrix result, both member-isolation scans, camera/library results, offline Vision result, and private-receipt acceptance result here before enabling production. Do not record tokens, import IDs, host/account identifiers, or receipt text.

### 2026-11-02 implementation verification

- Worker: 10 files / 88 tests passed; TypeScript typecheck passed.
- Viewer: 21 files / 131 tests passed; Viewer typecheck and production build passed.
- Browser: all 8 Playwright flows passed, including populated Shortcut return, safe navigation during import, unusable/expired import behavior, no production OCR request, and safe inbox dismissal/conflict refresh.
- Local application: all 256 Python tests passed.
- Production Viewer build contains no PaddleOCR worker, model, runtime, or receipt-fixture assets. The private development benchmark remains available only under the development server.
- Production retains `FEATURE_RECEIPT_SHORTCUT=false`. No Shortcut was installed, no private receipt text was uploaded, and no real-device acceptance result is claimed by this automated gate.

### 2026-11-02 staging Access and feature gate

- Staging D1 applied migration `0005`; the immediate second application reported no pending migrations.
- The existing staging Viewer Access application retains its household Allow policy and now has one exact `public` destination override for the receipt import endpoint. No wildcard or separate prefix-matching application remains.
- Unauthenticated `GET`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS` on the exact endpoint returned `405` with `Allow: POST`; `POST` without a bearer token returned `401 RECEIPT_SCAN_SESSION_INVALID`.
- The deeper receipt-import path, its parent path, authenticated receipt-claim path, and Viewer root still redirect to Access. The equivalent production endpoint also remains Access-protected.
- Staging Viewer version `1e90a825-698d-49be-ae4d-9a318878d0a1` is deployed with `FEATURE_RECEIPT_SHORTCUT=true`; production remains false.
- Valid-token replay, cross-member isolation, camera/library, offline Vision, and private-receipt acceptance still require physical iPhone testing before production activation.
