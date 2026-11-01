# Receipt OCR Accuracy Design

## Goal

Make receipt scanning accurate enough for real crumpled, skewed, faded household receipts while keeping the normal path free, private, and on-device. A scan is successful only when its merchant, purchase date, receipt total, and every accepted item are supported by visible OCR evidence and the arithmetic reconciles.

## Decisions

- Replace Tesseract.js with PaddleOCR.js PP-OCRv6 small. It was materially more accurate on all nine supplied images and preserves polygons for spatial parsing.
- Self-host the pinned detection, recognition, and ONNX runtime assets. The browser never depends on a third-party model CDN at runtime.
- Keep receipt images in browser IndexedDB. The ordinary scan path does not upload images or send them to an LLM.
- Parse spatial observations rather than flattened text. Receipt descriptions and prices often occupy separate columns and must be paired by vertical overlap.
- Detect near-identical full-page photos before parsing so two photos of one receipt do not create duplicate items.
- Treat arithmetic and confidence as gates. Unreconciled or low-confidence lines remain editable and visibly flagged; the application does not silently invent text.
- Use local vision-model results only as a development cross-check for the supplied private benchmark. The shipped path does not require an LLM: PP-OCRv6 plus receipt arithmetic produced more reliable monetary output. A Mac refinement path is not part of this change because moving phone photos to the Mac would change the established privacy boundary and needs its own encrypted transport design.

## Pipeline

1. Prepare a JPEG with a 3,200-pixel maximum edge, preserving enough characters for narrow receipt fonts.
2. Load self-hosted PP-OCRv6 small detection and English recognition models in a dedicated browser worker.
3. Convert every recognized polygon into an OCR observation with its full bounding box, confidence, and page-relative position.
4. Remove duplicate pages only when their normalized observation fingerprints have overwhelming overlap.
5. Group observations into visual rows. Pair a textual description with a money-only observation on the same row.
6. Recognize common multi-row grocery patterns, including a product row followed by savings and `PRICE YOU PAY`.
7. Exclude payment, loyalty, address, authorization, subtotal, tax, and total rows from item lines.
8. Validate item sums against subtotal and subtotal/discount/tax/tip/fees against total. Mark uncertainty rather than guessing.

## Privacy and supply chain

- Model downloads happen during the controlled build asset-copy step, not while a user scans.
- Each downloaded model is pinned by URL and SHA-256. A hash mismatch fails the build.
- Browser inference uses only same-origin assets under `/receipt-ocr/`.
- No receipt image or OCR text is sent to Paddle, Ollama, Apple, or any hosted service.

## Acceptance

- All nine supplied images have exact visible merchant/summary extraction and exact monetary line extraction in the private local benchmark. The two views of one ACME receipt collapse to one 16-line receipt. A field that is not printed in the photographed area, such as the Target date, remains blank for review instead of being invented.
- Duplicate ACME and Lowe's photos do not double items.
- All parser behavior is covered by sanitized spatial observation fixtures; private images are not committed.
- Existing receipt creation, review, and reconciliation behavior remains compatible.
- Viewer build works without any Tesseract assets or dependencies.
