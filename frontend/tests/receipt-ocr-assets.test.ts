import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RECEIPT_OCR_DETECTION_MODEL_URL,
  RECEIPT_OCR_RECOGNITION_MODEL_URL,
  RECEIPT_OCR_RUNTIME_PATH,
} from "../src/viewer/receipts/receiptOcr";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("receipt OCR assets", () => {
  it("uses only same-origin runtime paths", () => {
    for (const assetPath of [
      RECEIPT_OCR_DETECTION_MODEL_URL,
      RECEIPT_OCR_RECOGNITION_MODEL_URL,
      RECEIPT_OCR_RUNTIME_PATH,
    ]) {
      expect(assetPath).toMatch(/^\/receipt-ocr\//);
      expect(assetPath).not.toMatch(/^https?:\/\//);
    }
  });

  it("copies the pinned ONNX browser runtime", () => {
    const output = mkdtempSync(join(tmpdir(), "fintracka-receipt-ocr-"));
    temporaryDirectories.push(output);
    execFileSync(process.execPath, [resolve("scripts/copy-receipt-ocr-assets.mjs"), output], {
      cwd: resolve("."), stdio: "pipe", env: { ...process.env, FINTRACKA_RECEIPT_OCR_SKIP_MODELS: "1" },
    });

    expect(readFileSync(join(output, "ort", "ort-wasm-simd-threaded.mjs"))).not.toHaveLength(0);
    expect(readFileSync(join(output, "ort", "ort-wasm-simd-threaded.wasm"))).not.toHaveLength(0);
    expect(readFileSync(join(output, "ort", "ort-wasm-simd-threaded.jsep.mjs"))).not.toHaveLength(0);
    expect(statSync(join(output, "ort", "ort-wasm-simd-threaded.jsep.wasm")).size)
      .toBeLessThanOrEqual(25 * 1024 * 1024);
  });

  it("keeps the main bundle on the CPU/WASM-only ONNX entry", () => {
    const config = readFileSync(resolve("vite.viewer.config.ts"), "utf8");
    expect(config).toContain('"onnxruntime-web": "onnxruntime-web/wasm"');
    expect(config).toContain('"onnxruntime-web-use-extern-wasm"');
  });

  it("pins the ONNX runtime version used by PaddleOCR's prebuilt worker", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies["onnxruntime-web"]).toBe("1.24.3");
  });

  it("pins both official models by sha256 and has no runtime remote fallback", () => {
    const copier = readFileSync(resolve("scripts/copy-receipt-ocr-assets.mjs"), "utf8");
    expect(copier.match(/sha256: "[a-f0-9]{64}"/g)).toHaveLength(2);
    const adapter = readFileSync(resolve("src/viewer/receipts/receiptOcr.ts"), "utf8");
    expect(adapter).not.toMatch(/https?:\/\//);
    expect(adapter.toLowerCase()).not.toContain("cdn");
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
