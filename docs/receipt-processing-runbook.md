# Receipt processing runbook

FinTracka receipt capture uses one canonical **FinTracka Receipt Scanner v4** Shortcut. The iPhone runs Apple Vision OCR plus the two Apple Intelligence model routes, writes a private package to a shared iCloud Drive folder, and stops. David's Mac relays completed packages to the authenticated FinTracka Worker. There is no Shortcut URL upload, callback, clipboard handoff, browser OCR, or paid OCR/LLM service.

See [receipt-shortcut-setup.md](receipt-shortcut-setup.md) for installation and [receipt-shortcut-v4-actions.md](receipt-shortcut-v4-actions.md) for the inspected action contract.

## Trust boundaries

- The browser creates an opaque, member-bound handoff ID. The Shortcut receives only the contract name and that ID.
- The shared `FinTracka Receipt Queue` folder is private to David and Ariela. Receipt images, OCR, and model output remain there until the Mac relays them.
- The Mac accepts only active handoff IDs, strict filenames, 1–12 ordered HEIC pages, bounded UTF-8 files, a manifest written last, and no symlinks.
- The Worker revalidates the member-bound session, canonicalizes the capture, rejects changed replay, and exposes handoffs only to the member who created them.
- A receipt import never changes the ledger. The household user reviews it and explicitly matches one exact posted transaction.
- No log, browser storage, manifest, public response, or committed artifact may contain receipt text, photos, access credentials, account identifiers, or financial details.

## Automated gate

Run from a clean worktree:

```sh
./scripts/verify-receipt-hybrid.sh
```

The gate runs Worker tests/typecheck/deployment checks, frontend tests/typecheck/viewer build, Python tests, Swift tests plus native OCR self-tests, the v4 Shortcut build/action audit, signed-artifact/archive checks, the local secret scan, private-image artifact checks, and `git diff --check`.

In an environment where policy forbids launching an external test browser, use:

```sh
FINTRACKA_SKIP_EXTERNAL_BROWSER=1 ./scripts/verify-receipt-hybrid.sh
```

That mode still parses and lists the focused Playwright suite but does not launch it. Browser behavior must then be checked through the permitted in-app browser and recorded separately; it is not equivalent to a Playwright pass.

## Safe rollout order

1. Keep production v4 advertisement disabled.
2. Apply D1 migration `0008_receipt_queue_handoffs.sql` in staging. Run the migration command again and require no pending migration.
3. Deploy the Worker with queue routes present but v4 advertisement disabled. Verify legacy versions 2 and 3 still create their original session payloads.
4. Install the updated Mac package parser/relay and the existing once-per-minute mobile-command schedule. Do not install a second daemon.
5. With synthetic data, verify active-ID fetch, one package completion, exact replay returning the same import, changed replay rejection, redacted logs, successful package deletion, and temporary-failure retention.
6. Deploy the viewer, enable v4 for David only, replace the canonical Shortcut, and complete David's matrix in [receipt-shortcut-v4-physical-matrix.md](receipt-shortcut-v4-physical-matrix.md).
7. Enable v4 for Ariela only after David passes. Confirm the shared folder and member isolation, then complete Ariela's matrix.
8. Review one real receipt without matching it automatically. Compare both model outputs to the receipt, select the better result, and verify summary arithmetic and all purchased lines.
9. Enable v4 advertisement for both members only after the signed matrices pass. Keep legacy upload support for a seven-day drain window.

## Mac relay operations

```sh
.venv/bin/fintracka remote commands schedule install
.venv/bin/fintracka remote commands schedule status
.venv/bin/fintracka remote commands process
```

Expected states:

- `pending`: package has not been relayed yet; safe while the Mac is asleep.
- `processing`: Mac validated the package and began its authenticated upload.
- `ready`: one immutable receipt import exists and the inbox can open it.
- `failed`: terminal safe error; the UI gives generic retry guidance and does not expose internal codes.

Temporary iCloud, network, or OCR-helper conditions retry without creating another handoff. A terminal invalid package is reported to the Worker first and moves to local `failed` storage only after that acknowledgment; if the acknowledgment is lost, the package stays pending for an idempotent retry. One bad package does not stop later packages in the same scheduled pass.

## Controlled reconciliation

The household user—not an agent—chooses the receipt and intended transaction.

1. Review merchant, date, every purchased line, subtotal, discounts, tax, tip, fees, total, owner, category, and subcategory.
2. Compare both Apple model outputs to the photo. Do not accept an unsupported field merely because a model returned it.
3. Select the exact posted transaction. Require exact currency and total and the current split revision.
4. Apply once and run the Mac processor. Confirm one application, one split-revision increment, and exact signed split sum.
5. Run the processor again. Confirm counts and revision do not change.

## Rollback

1. Disable v4 advertisement first and redeploy. New scans then fail closed to the accepted legacy path.
2. Stop the existing mobile-command schedule only if relay processing itself must stop.
3. Reinstall the last accepted signed Shortcut if capture must roll back.
4. Leave additive D1/SQLite migrations and queued packages in place. Do not delete the shared folder until every package is reviewed or expired.
5. Never delete local command receipts; they are the exact-once evidence.

## Production completion rule

Do not call v4 complete, fixed, or working on iPhone until:

- the automated gate passes from a clean commit;
- both signed phone matrices pass;
- the allowed browser check passes;
- the production URL advertises v4 to both intended members;
- one user-reviewed real receipt reaches the existing review screen exactly once.
