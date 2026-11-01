# Receipt processing runbook

FinTracka scans receipt images locally in the authenticated phone browser. Original images and OCR text never leave that browser. Only a reviewed, structured draft is stored in the household D1 database; SQLite on the Mac remains the financial system of record.

## Security and correctness boundaries

- The browser must explicitly select a posted bank transaction. Matching is never automatic.
- The Worker accepts only a negative transaction with the exact total and currency, within seven calendar days, and the current `split_revision`.
- The command contains only IDs, revisions, and SHA-256 digests. It contains no merchant, item text, account name, or amount.
- The Mac fetches the immutable receipt revision with its dedicated Access service identity, recalculates the digest, and repeats all transaction eligibility checks.
- Receipt application, detailed splits, audit data, and the permanent command receipt commit in one SQLite transaction. A retried command is a no-op.
- D1 stores no images or full card numbers. Local browser images expire after 30 days; D1 drafts/revisions expire after 90 days. Permanent redacted applications remain in SQLite to guarantee replay safety.

## Safe deployment order

1. Create and verify a local SQLite backup. Keep the once-per-minute command processor disabled.
2. Build and test the Viewer against snapshot schemas 1, 2, and 3.
3. Apply D1 migrations through `0004_receipt_commands.sql` in staging. Run the command again and require “no migrations to apply.”
4. Deploy the Viewer Worker with `FEATURE_RECEIPT_DRAFTS=false` and `FEATURE_RECEIPT_MATCHING=false`.
5. Migrate a copied/synthetic SQLite database through migration 021 and require `PRAGMA foreign_key_check` to return no rows.
6. Publish a synthetic snapshot v3. Verify older snapshots still read and v3 advertises `transaction.apply_receipt_split:[1]` and `receipts.matching:[1]`.
7. Enable drafts in staging only. Run the iPhone performance gate below. Keep financial matching false.
8. Enable matching in staging and complete the controlled synthetic reconciliation.
9. Repeat migrations, reader deployment, and idempotence checks in production with both flags false.
10. Enable production drafts only after the iPhone gate. Enable production matching and the minute processor only after the user-selected live reconciliation.

## Required iPhone gate

On a supported iPhone in the protected staging Viewer, use the receipt OCR benchmark and then the normal capture flow:

- one page completes within 15 seconds;
- six pages complete within 90 seconds;
- Safari does not reload or evict the page;
- Network inspection shows no third-party image, OCR, or receipt-text request;
- a long overlap is either collapsed only when exact or visibly flagged for review;
- photos remain usable while offline and are pruned after the local retention window.

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

1. Set `FEATURE_RECEIPT_MATCHING=false` and redeploy. Pending receipt commands remain inert if the Mac processor is also disabled.
2. Disable and remove the command schedule with the existing CLI commands.
3. Keep `FEATURE_RECEIPT_DRAFTS=true` only if capture/review should remain available; set it false to hide the entire receipt surface.
4. Do not reverse a D1 or SQLite migration in place. Restore the verified pre-migration SQLite backup if local rollback is necessary; D1 columns/tables may remain unused.
5. Never delete local command receipts before restoring an older database: they are the exact-once evidence.

Original-image cloud backup is explicitly out of scope. It requires a separate encrypted backup/recovery design and must not reuse the receipt draft store.

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

## 2026-11-01 real-receipt validation

- Corrected the pinned browser pairing to `tesseract.js` 7.0.0 plus `tesseract.js-core` 7.0.0 and packaged every native, SIMD, relaxed-SIMD, and LSTM loader locally. No OCR CDN fallback exists.
- The browser benchmark completed one prepared page in 1.3 seconds and six prepared pages in 1.5 seconds on the test Mac; cancellation returned `Receipt recognition was cancelled`, the page remained alive, and every request stayed on the local origin or a local `blob:` URL.
- Nine real HEIC receipt photos, including glare, wrinkles, perspective, faint thermal print, and multi-page overlap, completed in 9.7 seconds total with a reused local worker. Low-confidence fields remained reviewable rather than being silently trusted.
- Two exact posted purchases were applied locally after timestamped SQLite backups: Home Depot $23.89 (one detailed line) and Liquor Wine Warehouse $162.20 (four detailed lines). Each increased `split_revision` exactly once, reconciled to the signed transaction amount, passed `PRAGMA foreign_key_check`, and was unchanged by an identical replay.
- iPhone Mirroring displayed the protected Viewer but macOS automation could not interact with the mirrored window. The Mac/browser benchmark is evidence for packaging, privacy, cancellation, and baseline performance; it does not replace the required physical iPhone Safari gate, so production receipt flags remain disabled.
