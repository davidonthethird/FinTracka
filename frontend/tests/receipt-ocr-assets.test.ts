import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RECEIPT_OCR_CORE_PATH,
  RECEIPT_OCR_LANGUAGE_PATH,
  RECEIPT_OCR_WORKER_PATH,
} from "../src/viewer/receipts/receiptOcr";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("receipt OCR assets", () => {
  it("uses only same-origin paths", () => {
    for (const assetPath of [RECEIPT_OCR_WORKER_PATH, RECEIPT_OCR_CORE_PATH, RECEIPT_OCR_LANGUAGE_PATH]) {
      expect(assetPath).toMatch(/^\/receipt-ocr\//);
      expect(assetPath).not.toMatch(/^https?:\/\//);
    }
  });

  it("copies the pinned worker, all selectable core builds, and English data", () => {
    const output = mkdtempSync(join(tmpdir(), "fintracka-receipt-ocr-"));
    temporaryDirectories.push(output);
    execFileSync(process.execPath, [resolve("scripts/copy-receipt-ocr-assets.mjs"), output], {
      cwd: resolve("."),
      stdio: "pipe",
    });

    expect(readFileSync(join(output, "worker.min.js"))).not.toHaveLength(0);
    expect(readFileSync(join(output, "lang", "eng.traineddata.gz"))).not.toHaveLength(0);
    const coreFiles = readdirSync(join(output, "core"));
    expect(coreFiles).toEqual(expect.arrayContaining([
      "tesseract-core.js",
      "tesseract-core.wasm",
      "tesseract-core.wasm.js",
      "tesseract-core-simd.js",
      "tesseract-core-simd.wasm",
      "tesseract-core-simd.wasm.js",
      "tesseract-core-relaxedsimd.js",
      "tesseract-core-relaxedsimd.wasm",
      "tesseract-core-relaxedsimd.wasm.js",
      "tesseract-core-lstm.js",
      "tesseract-core-lstm.wasm",
      "tesseract-core-lstm.wasm.js",
      "tesseract-core-simd-lstm.js",
      "tesseract-core-simd-lstm.wasm",
      "tesseract-core-simd-lstm.wasm.js",
      "tesseract-core-relaxedsimd-lstm.js",
      "tesseract-core-relaxedsimd-lstm.wasm",
      "tesseract-core-relaxedsimd-lstm.wasm.js",
    ]));
  });

  it("contains no remote fallback in the copier or OCR adapter", () => {
    const sources = [
      readFileSync(resolve("scripts/copy-receipt-ocr-assets.mjs"), "utf8"),
      readFileSync(resolve("src/viewer/receipts/receiptOcr.ts"), "utf8"),
    ].join("\n");
    expect(sources).not.toMatch(/https?:\/\//);
    expect(sources.toLowerCase()).not.toContain("cdn");
  });

  it("uses raster benchmark fixtures that the OCR engine can decode", () => {
    for (const name of ["one-page.png", "overlap-page.png"]) {
      expect(readFileSync(resolve("public", "receipt-fixtures", name)).subarray(0, 8))
        .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    expect(readFileSync(resolve("src/viewer/receipts/ReceiptOcrBenchmark.tsx"), "utf8"))
      .not.toContain(".svg");
  });
});
