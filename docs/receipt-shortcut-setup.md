# FinTracka Receipt Scanner v5 setup

This is the only supported receipt Shortcut. It captures receipt pages, runs Apple Vision OCR plus one fixed Apple Intelligence **Cloud Pro** route on the iPhone, saves a complete private package to shared iCloud Drive, and then publishes only OCR plus the model result with a one-time FinTracka token. Receipt photos do not leave the shared Apple boundary.

The installable artifact is generated from inspected source by the trusted signing script. The action contract is documented in [receipt-shortcut-v5-actions.md](receipt-shortcut-v5-actions.md).

## Privacy and data flow

1. FinTracka creates an opaque handoff identifier and single-use token and passes them to the Shortcut as three text lines.
2. The Shortcut stores receipt photos, OCR, and the Cloud Pro result in the private shared iCloud folder, writing `manifest.txt` last.
3. After that durable save, the Shortcut uploads the same OCR and Cloud Pro result so the draft can be edited immediately.
4. David or Ariela can assign David, Ariela, or Shared immediately. Matching remains locked until David's Mac verifies the private package against the same canonical digest.

## One-time shared-folder setup

1. David creates `FinTracka Receipt Queue` in iCloud Drive and shares that folder privately with **Ariela**, with edit permission.
2. David and Ariela each open the shared folder once in Files so iOS grants Shortcuts access.
3. Do not store unrelated files in this folder. FinTracka only processes the strict package layout under `pending/<handoff-id>/`.

## Install on each iPhone

1. Delete every old or numbered FinTracka receipt Shortcut. There must be exactly one Shortcut named **FinTracka Receipt Scanner**.
2. Run `./scripts/sign-receipt-shortcut-v5.sh "$PWD/dist/receipt-shortcut"`, then install the exact `dist/receipt-shortcut/FinTracka Receipt Scanner.shortcut` file it creates.
3. During installation, choose the shared **FinTracka Receipt Queue** folder when asked where receipt packages belong.
4. Allow camera, Photos, iCloud Drive, Extract Text, and Apple Intelligence access when iOS asks. Choose **Always Allow** only for the actions shown inside this trusted signed Shortcut.
5. Start scans from FinTracka. Do not run the Shortcut tile directly: direct runs have no handoff identifier and correctly stop.

The Shortcut input must be exactly:

```text
receipt_immediate_handoff/v1
<opaque UUID>
<43-character one-time token>
```

It creates:

```text
FinTracka Receipt Queue/
  pending/<handoff-id>/
    page-001.heic
    ...
    ocr.txt
    on-device.txt
    private-cloud-compute.txt
    manifest.txt
```

`manifest.txt` is written last and tells the Mac that the package is complete.

## Normal use

1. In FinTracka, open **Transactions → Scan receipt**.
2. Choose **Scan with iPhone** and select the canonical Shortcut if iOS asks.
3. Take 1–12 photos in order or choose 1–12 photos from the library.
4. Wait for the result. A successful upload makes the receipt immediately reviewable even while the Mac is asleep; a failed upload leaves the complete private package queued.
5. Return to FinTracka, assign David, Ariela, or Shared, and save. Transaction matching unlocks only after the Mac verifies the package.

Apple does not document an action-level catch/continue control for `Use Model`. The Shortcut therefore saves the Cloud Pro response only after that action succeeds and writes `manifest.txt` last. If Cloud Pro fails, the Shortcut stops without a manifest and the Mac ignores the incomplete package. The user can retry; FinTracka must not invent missing receipt fields.

## Mac relay

The existing FinTracka processor relays completed packages; no second daemon is installed.

```sh
.venv/bin/fintracka remote commands schedule install
.venv/bin/fintracka remote commands schedule status
.venv/bin/fintracka remote commands process
```

The processor validates the handoff ID, file names, page count, sizes, UTF-8 text, and manifest before upload. It never follows symlinks. On success it removes the private package; temporary failures remain queued; terminal invalid packages move to `failed` for review.

## Build and verify the Shortcut

```sh
python3 scripts/build-receipt-shortcut-v5.py
plutil -lint "shortcuts/FinTracka Receipt Scanner.plist"
python3 scripts/verify-receipt-shortcut-v5.py \
  "shortcuts/FinTracka Receipt Scanner.plist"

./scripts/sign-receipt-shortcut-v5.sh "$PWD/dist/receipt-shortcut"
```

Install only the exact artifact produced in `dist/receipt-shortcut` by that command. The trusted signing script verifies and validates the inspected plist immediately before signing it, replacing any pre-existing output. This avoids treating a checked-in opaque binary or editable hash sidecar as proof of signed content. Its all-platform validator mode is required because Apple's current ToolKit snapshot mislabels the legacy Extract Text action even though that identifier exists in the known physical-iPhone export. The physical acceptance matrix below remains mandatory.

## Acceptance matrix

Run every row on both David's and Ariela's phones before production rollout:

| Source | Pages | Mac state | Required outcome |
|---|---:|---|---|
| Camera | 1 | Awake | One package, then one populated review |
| Photo library | 1 | Awake | One package, then one populated review |
| Camera | 2+ | Awake | Page order preserved; no duplicate lines |
| Photo library | 2+ | Awake | Page order preserved; no duplicate lines |
| Either | 1+ | Asleep | Draft opens immediately; owner saves; matching stays locked |
| Either | 1+ | Awake | Cloud Pro output produces one populated review |
| Either | 1+ | Awake | Cloud Pro succeeds and the complete package relays; a failed model action leaves no processable manifest and the user retries |

Also verify:

- Directly running the Shortcut stops with the missing/invalid handoff message and creates no package.
- Reusing the same handoff ID creates no duplicate receipt.
- Missing Cloud Pro output never becomes a processable package because `manifest.txt` is absent.
- A malformed or oversized package is rejected without deleting unrelated files.
- Receipt photos and text never appear in logs, browser storage, or a public Worker response.
- The one-time token is not saved in iCloud, logs, comments, or browser storage.
- Mac verification changes verification state only; it never overwrites the saved owner.
- No receipt affects the ledger until a user explicitly reviews and matches it.

Record only pass/fail and timestamps. Do not record receipt text, photos, tokens, account identifiers, or financial details.

## Rollback

1. Disable the receipt handoff feature flag and deploy that fail-closed setting.
2. Stop the existing mobile-command schedule only if relay processing itself must stop.
3. Reinstall the last accepted signed Shortcut if the capture workflow must roll back.
4. Leave queued packages in place for review. Do not delete the shared folder or additive database migrations.

## References

- [Apple: Use Apple Intelligence in Shortcuts](https://support.apple.com/guide/iphone/iph78c41eaf8/ios)
- [Apple: Using Dictionaries in Shortcuts](https://support.apple.com/guide/shortcuts/apd43b69f337/ios)
- [Apple: Share shortcuts](https://support.apple.com/guide/shortcuts/apdf01f8c054/ios)
