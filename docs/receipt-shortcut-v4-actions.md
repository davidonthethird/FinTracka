# FinTracka Receipt Scanner Shortcut (version 4)

The inspectable source is `shortcuts/FinTracka Receipt Scanner.plist`; `scripts/build-receipt-shortcut-v4.py` rebuilds it and `scripts/verify-receipt-shortcut-v4.py` enforces the action contract. The installable artifact is created only by the trusted signing script so the file installed on a phone is the exact output of source verification and signing, not an opaque prebuilt binary from the repository.

Version 4 deliberately has no network request, browser transfer, persistent secret, or nested Shortcut. It receives only:

```text
receipt_queue_handoff/v1
<opaque UUID>
```

## Exact action phases

1. Match the complete two-line input against the handoff contract and UUID shape. Explain and stop on any mismatch.
2. Choose **Take photos** or **Choose from Photo Library**. Camera capture asks for 1–12 pages; library capture permits multiple images. Count and reject anything outside 1–12 without creating a queue folder.
3. Create `pending/<handoff-id>` inside the private shared **FinTracka Receipt Queue** folder selected at install only after valid page selection.
4. Repeat through pages in order. Convert each `Repeat Item` to HEIF, save it as `page-001.heic` through `page-012.heic`, and run Extract Text from Image once.
5. Add `--- PAGE N ---` before each OCR result and combine all page text into `ocr.txt`.
6. Give the same combined OCR and ordered pages to two fixed Use Model actions: **Apple Intelligence on Device** and **Private Cloud Compute**. Broad world knowledge and Follow Up stay off.
7. Save each model response separately as `on-device.txt` and `private-cloud-compute.txt`, with separate status and duration fields.
8. Save `manifest.txt` last. It contains fixed scalar fields only; arbitrary OCR and model output never enter the manifest.
9. Confirm that the private package was saved. The Mac relay and FinTracka inbox finish asynchronously; the Shortcut does not attempt to reopen the browser.

## Package contract

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

The manifest is strict UTF-8 and is the readiness marker:

```text
contract=receipt_queue_capture/v1
handoff_id=<UUID>
page_count=<1..12>
created_at=<ISO-8601>
on_device_status=completed|unavailable
on_device_duration_ms=<integer>
private_cloud_compute_status=completed|unavailable
private_cloud_compute_duration_ms=<integer>
```

## Rebuild and inspect

```sh
python3 scripts/build-receipt-shortcut-v4.py
python3 scripts/verify-receipt-shortcut-v4.py \
  "shortcuts/FinTracka Receipt Scanner.plist"

./scripts/sign-receipt-shortcut-v4.sh "$PWD/dist/receipt-shortcut"
```

Install only `dist/receipt-shortcut/FinTracka Receipt Scanner.shortcut` from that signing run. The trusted signing script validates the already-inspected plist and replaces the target artifact in one step. `--target-platform all` is intentional: Apple's current ToolKit snapshot labels the legacy Extract Text from Image identifier as macOS-only, although that same identifier is present in the existing physical-iPhone Shortcut export. The signed artifact still requires physical acceptance on both phones before rollout, including a run where one model is unavailable because Apple does not document action-level error recovery for `Use Model`.
