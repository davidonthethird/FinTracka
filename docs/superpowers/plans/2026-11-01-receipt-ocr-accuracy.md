# Receipt OCR Accuracy Implementation Plan

**Goal:** Replace the current low-accuracy browser OCR path with a private self-hosted PaddleOCR pipeline and spatial receipt parser proven against the supplied real-world samples.

**Architecture:** PaddleOCR.js runs in a browser worker using pinned same-origin model assets. It produces polygon observations. A deterministic spatial parser performs page deduplication, row pairing, summary exclusion, grocery savings handling, and reconciliation checks. Private photos remain local and outside git.

**Tech stack:** React, TypeScript, Vite, Vitest, PaddleOCR.js, ONNX Runtime Web.

## Tasks

1. Add failing OCR adapter tests for Paddle polygons, progress, cancellation, and disposal.
2. Add failing parser tests for split columns, duplicate pages, savings rows, and the six sanitized receipt structures.
3. Replace Tesseract dependencies and asset copying with pinned Paddle model/runtime assets.
4. Implement the Paddle worker adapter and observation conversion.
5. Implement spatial rows, page deduplication, item pairing, summary filtering, and validation flags.
6. Increase image preparation resolution and surface uncertainty in receipt review.
7. Run targeted unit tests, typechecks, production viewer build, local private image benchmark, and a mobile-sized browser smoke test.
8. Review the diff for privacy, correctness, and unnecessary complexity; then commit and prepare the PR.
