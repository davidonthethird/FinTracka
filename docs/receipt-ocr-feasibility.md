# Receipt OCR Feasibility

## Automated gate

- Engine: Tesseract.js 7.0.0 with Tesseract core 6.1.2 and English data 1.0.0.
- Privacy: worker, core, and language data are copied into the Viewer build and loaded from same-origin paths.
- Fixtures: synthetic one-page and overlapping-page receipts only.
- Selected preprocessing ceiling: 2,400 pixels on the longest edge (implemented in the image-preparation boundary).
- Desktop build: Viewer type-check and production build pass.

## Required staged iPhone gate

Before production receipt OCR is enabled, use `/__receipt-ocr-benchmark` in a development/staging Viewer build and record:

- iPhone model and iOS version;
- input dimensions after preparation;
- cold one-page duration (must be no more than 15 seconds);
- six-page sequential duration (must be no more than 90 seconds);
- whether Safari reloaded, memory warnings appeared, or cancellation failed.

Receipt OCR and financial matching remain disabled in production until this gate passes. If one bounded-resolution adjustment still fails, the browser OCR approach must be revisited rather than silently weakening the gate.
