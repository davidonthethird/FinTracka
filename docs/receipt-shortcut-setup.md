# FinTracka Receipt Scanner v4 setup

This is the only supported receipt Shortcut. It captures receipt pages, runs Apple Vision OCR plus both Apple Intelligence model routes on the iPhone, and saves one private package to a shared iCloud Drive folder. It does not call FinTracka, open a browser, use the clipboard, or put a credential in the Shortcut.

The installable artifact is generated from the inspected source by the trusted signing script. FinTracka deliberately does not track a prebuilt Scanner binary because its contents cannot be reviewed or tied back to the source. The action contract is documented in [receipt-shortcut-v4-actions.md](receipt-shortcut-v4-actions.md).

## Privacy and data flow

1. FinTracka creates an opaque handoff identifier and shows it to the Shortcut as two text lines.
2. The Shortcut stores receipt photos, OCR, and the two model results only in the private shared iCloud folder.
3. David's Mac relays the completed package into FinTracka when it is awake. Until then the receipt remains queued.
4. The FinTracka inbox displays queued, relaying, ready, and failed states. Nothing changes the ledger until a user reviews and matches the receipt.

## One-time shared-folder setup

1. David creates `FinTracka Receipt Queue` in iCloud Drive and shares that folder privately with **Ariela**, with edit permission.
2. David and Ariela each open the shared folder once in Files so iOS grants Shortcuts access.
3. Do not store unrelated files in this folder. FinTracka only processes the strict package layout under `pending/<handoff-id>/`.

## Install on each iPhone

1. Delete every old or numbered FinTracka receipt Shortcut. There must be exactly one Shortcut named **FinTracka Receipt Scanner**.
2. Run `./scripts/sign-receipt-shortcut-v4.sh "$PWD/dist/receipt-shortcut"`, then install the exact `dist/receipt-shortcut/FinTracka Receipt Scanner.shortcut` file it creates.
3. During installation, choose the shared **FinTracka Receipt Queue** folder when asked where receipt packages belong.
4. Allow camera, Photos, iCloud Drive, Extract Text, and Apple Intelligence access when iOS asks. Choose **Always Allow** only for the actions shown inside this trusted signed Shortcut.
5. Start scans from FinTracka. Do not run the Shortcut tile directly: direct runs have no handoff identifier and correctly stop.

The Shortcut input must be exactly:

```text
receipt_queue_handoff/v1
<opaque UUID>
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
4. Wait for the success message. The Shortcut can finish even while the Mac is asleep because the package waits privately in iCloud.
5. Return to FinTracka. The inbox updates from **Queued on iPhone** to **Waiting for Mac**, **Processing**, and then **Ready to review**.

If a model returns no usable response, its status is recorded as unavailable and the other captured evidence is retained. Apple does not document an action-level catch/continue control for `Use Model`; therefore a device-level model-action failure is a mandatory physical acceptance case and rollout remains blocked if it prevents the package from being saved. FinTracka must not invent missing receipt fields.

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
python3 scripts/build-receipt-shortcut-v4.py
plutil -lint "shortcuts/FinTracka Receipt Scanner.plist"
python3 scripts/verify-receipt-shortcut-v4.py \
  "shortcuts/FinTracka Receipt Scanner.plist"

./scripts/sign-receipt-shortcut-v4.sh "$PWD/dist/receipt-shortcut"
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
| Either | 1+ | Asleep | Package waits, then resumes after Mac wakes |
| Either | 1+ | Awake | On-device and Private Cloud Compute outputs are shown separately for comparison |
| Either | 1+ | Awake | If one `Use Model` action is unavailable, the package still saves the OCR and other model evidence; otherwise rollout is blocked |

Also verify:

- Directly running the Shortcut stops with the missing/invalid handoff message and creates no package.
- Reusing the same handoff ID creates no duplicate receipt.
- Missing model output is visibly unavailable, not silently accepted.
- A malformed or oversized package is rejected without deleting unrelated files.
- Receipt photos and text never appear in logs, browser storage, or a public Worker response.
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
