import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(process.argv[2] ?? resolve(frontendRoot, "public", "receipt-ocr"));
const cacheRoot = resolve(process.env.FINTRACKA_RECEIPT_OCR_MODEL_CACHE
  ?? resolve(frontendRoot, "node_modules", ".cache", "fintracka-receipt-ocr"));
const ortRoot = resolve(frontendRoot, "node_modules", "onnxruntime-web", "dist");
const runtimeFiles = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];
const models = [
  {
    name: "PP-OCRv6_small_det.tar",
    url: "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_det_onnx_infer.tar",
    sha256: "d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4",
  },
  {
    name: "PP-OCRv6_small_rec.tar",
    url: "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_rec_onnx_infer.tar",
    sha256: "d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1",
  },
];

for (const file of runtimeFiles) {
  if (!existsSync(resolve(ortRoot, file))) throw new Error(`Missing pinned ONNX runtime asset: ${file}`);
}

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(resolve(outputRoot, "ort"), { recursive: true });
mkdirSync(resolve(outputRoot, "models"), { recursive: true });
for (const file of runtimeFiles) cpSync(resolve(ortRoot, file), resolve(outputRoot, "ort", file));

if (process.env.FINTRACKA_RECEIPT_OCR_SKIP_MODELS !== "1") {
  mkdirSync(cacheRoot, { recursive: true });
  for (const model of models) {
    const cached = resolve(cacheRoot, model.name);
    if (!existsSync(cached) || sha256(cached) !== model.sha256) {
      const response = await fetch(model.url);
      if (!response.ok) throw new Error(`Unable to download pinned receipt OCR model ${model.name}: ${response.status}`);
      writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
    }
    const actual = sha256(cached);
    if (actual !== model.sha256) throw new Error(`Receipt OCR model hash mismatch for ${model.name}: ${actual}`);
    cpSync(cached, resolve(outputRoot, "models", model.name));
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
