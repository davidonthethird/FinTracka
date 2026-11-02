# Receipt OCR Feasibility

## Automated gate

- Engine: PaddleOCR.js 0.4.2 with pinned PP-OCRv6-small detection and English recognition models.
- Privacy: model, ONNX runtime, worker, and WASM assets are self-hosted and loaded only from same-origin paths. Images and OCR text are not sent to Paddle, an LLM, or another service.
- Integrity: build-time model downloads are SHA-256 pinned; runtime CDN fallback is not allowed.
- Fixtures: synthetic spatial-layout, overlap, sale-price, arithmetic-reconciliation, and checkout-screen cases.
- Private benchmark: all nine supplied local images produced exact visible merchant/summary values and exact monetary lines. The two ACME angles collapse to one 16-line receipt.
- Selected preprocessing ceiling: 3,200 pixels on the longest edge.
- Loading: the OCR implementation is lazy-loaded only when receipt scanning starts; the normal Viewer bundle does not load it.
- Mac baseline: one prepared Target page completed in 7.0 seconds from a cold headless-browser run. This is not a substitute for the physical-iPhone gate.
- Desktop verification: Viewer type-check, production build, 105 frontend tests, and the repository verification suites pass.

## Required staged iPhone gate

Before production receipt OCR is enabled, use `/__receipt-ocr-benchmark` in a development/staging Viewer build and record:

- iPhone model and iOS version;
- input dimensions after preparation;
- cold one-page duration (must be no more than 15 seconds);
- six-page sequential duration (must be no more than 90 seconds);
- whether Safari reloaded, memory warnings appeared, or cancellation failed.

Receipt OCR and financial matching remain disabled in production until this gate passes. The nine private photos prove accuracy on the supplied examples, not universal accuracy on arbitrary future receipts; unreadable or arithmetically inconsistent fields must remain editable and visibly flagged. If one bounded-resolution adjustment still fails, the browser OCR approach must be revisited rather than silently weakening the gate.
