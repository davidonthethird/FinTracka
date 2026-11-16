# FinTracka Receipt Scanner Shortcut (version 5)

The inspectable source is `shortcuts/FinTracka Receipt Scanner.plist`; `scripts/build-receipt-shortcut-v5.py` rebuilds it and `scripts/verify-receipt-shortcut-v5.py` enforces the action contract. The trusted signing script signs exactly that verified plist.

Version 5 has one fixed HTTPS request protected by the single-use token FinTracka creates for that scan. It has no Access credential, persistent secret, clipboard transfer, callback URL, JavaScript, shell action, or nested Shortcut. It receives exactly:

```text
receipt_immediate_handoff/v1
<opaque UUID>
<43-character one-time token>
```

## Exact action phases

1. Match the complete three-line input against the handoff contract, UUID shape, and token shape. Explain and stop on any mismatch.
2. Choose **Take photos** or **Choose from Photo Library**. Camera capture asks for 1–12 pages; library capture permits multiple images. Count and reject anything outside 1–12 without creating a queue folder.
3. Create `pending/<handoff-id>` inside the private shared **FinTracka Receipt Queue** folder selected at install only after valid page selection.
4. Repeat through pages in order. Convert each `Repeat Item` to HEIF, save it as `page-001.heic` through `page-012.heic`, and run Extract Text from Image once.
5. Add `--- PAGE N ---` before each OCR result and combine all page text into `ocr.txt`.
6. Save `UNAVAILABLE` to `on-device.txt` as a compatibility marker, then give the combined OCR and ordered pages to one fixed **Cloud Pro** Use Model action. Broad world knowledge and Follow Up stay off.
7. Save the successful Cloud Pro response directly as `private-cloud-compute.txt`. Shortcuts stops before writing the manifest if Cloud Pro fails.
8. Save `manifest.txt` last. The complete private package now exists before any network request.
9. POST the same combined OCR and Cloud Pro output to the fixed production import endpoint with the one-time bearer token and `receipt_shortcut_capture/v2`.
10. Confirm immediate review when FinTracka returns an import ID. The private package remains the Mac fallback if publication fails.

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
on_device_status=unavailable
on_device_duration_ms=0
private_cloud_compute_status=completed
private_cloud_compute_duration_ms=<integer>
```

## Rebuild and inspect

```sh
python3 scripts/build-receipt-shortcut-v5.py
python3 scripts/verify-receipt-shortcut-v5.py \
  "shortcuts/FinTracka Receipt Scanner.plist"

./scripts/sign-receipt-shortcut-v5.sh "$PWD/dist/receipt-shortcut"
```

Install only `dist/receipt-shortcut/FinTracka Receipt Scanner.shortcut` from that signing run. The verifier asserts the exact 84-action inventory, one Cloud Pro route, one fixed upload, source-output wiring, and upload-after-manifest order. `--target-platform all` is intentional because Apple's validator still mislabels the legacy Extract Text action present on iPhone. Physical acceptance on both phones remains required.
