# FinTracka receipt model comparison Shortcut (version 3)

The signed benchmark artifact is [`shortcuts/FinTracka Receipt Scanner.shortcut`](../shortcuts/FinTracka%20Receipt%20Scanner.shortcut). Its inspectable source is `shortcuts/FinTracka Receipt Model Comparison.xml`. It was generated, validated, archived, and signed with Shortcuts Playground. Its installed workflow name is exactly **FinTracka Receipt Scanner**, matching the name launched by the web app.

Comparison mode is temporary and feature gated. Installing the benchmark artifact replaces the canonical `FinTracka Receipt Scanner` only for the private benchmark; comparison remains disabled in committed staging and production configuration until it is explicitly enabled and reviewed.

## Action order

1. Read the one-time FinTracka session Dictionary from Shortcut Input.
2. Read `token` and `upload_url` from that Dictionary.
3. Select one or more ordered receipt images from Photos.
4. Run Apple Vision **Extract from Image** once over that ordered input.
5. Freeze the recognized OCR result into a plain-text value.
6. Record the start/end time around **Use Model → On-Device**, output Text, Follow Up off, broad world knowledge off, then freeze its response into plain text.
7. Record the start/end time around **Use Model → Cloud**, output Text, Follow Up off, broad world knowledge off, then freeze its response into plain text.
8. Generate a SHA-256 idempotency key from the current date and plain recognized text.
9. POST one flat `receipt_shortcut_capture/v3` JSON body to the session upload URL with the bearer token. The request references only the three plain-text values, never the photo-backed action outputs.
10. Show the user that both results were sent and instruct them to tap Back to FinTracka.

The repository artifact intentionally uses the photo library for repeatable A/B tests against the same private receipt corpus. The production v2 scanner's camera path is unchanged.

The two Use Model actions contain the same prompt bytes and reference the same recognized text and ordered photo selection. Their saved Shortcuts model values are `Apple Intelligence on Device` and `Apple Intelligence`; shorter display-like values import with empty selectors. Apple does not guarantee image analysis for the On-Device model; the benchmark UI explains that limitation.

## Flat upload body

Apple Shortcuts serializes this flat form reliably. The Worker immediately normalizes it to the strict two-run internal schema.

```text
contract
idempotency_key
shortcut_version
text
on_device_status
on_device_duration_ms
on_device_model_result OR on_device_error_code
private_cloud_compute_status
private_cloud_compute_duration_ms
private_cloud_compute_model_result OR private_cloud_compute_error_code
```

The upload never contains a photo. Explicit Text actions remove photo provenance before the network boundary. Model output and recognized text live only on the existing expiring import. The 30-day benchmark table contains metadata only.

## Build verification

```sh
SHORTCUT_SKILL="$HOME/.codex/plugins/cache/shortcuts-playground/shortcuts-playground/1.2.1/skills/shortcuts-playground"
python3 "$SHORTCUT_SKILL/scripts/validate_shortcut.py" \
  "shortcuts/FinTracka Receipt Model Comparison.xml" \
  --target-platform all --target-macos 27
test -s "shortcuts/FinTracka Receipt Scanner.shortcut"
```

The `all` validation target is deliberate: current ToolKit metadata observes Apple Vision's Extract action on macOS, while the action was also verified on the physical iPhone.
