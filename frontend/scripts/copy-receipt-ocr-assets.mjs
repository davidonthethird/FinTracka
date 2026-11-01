import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(process.argv[2] ?? resolve(frontendRoot, "public", "receipt-ocr"));
const workerSource = resolve(frontendRoot, "node_modules", "tesseract.js", "dist", "worker.min.js");
const coreRoot = resolve(frontendRoot, "node_modules", "tesseract.js-core");
const languageSource = resolve(
  frontendRoot,
  "node_modules",
  "@tesseract.js-data",
  "eng",
  "4.0.0",
  "eng.traineddata.gz",
);
const coreFiles = [
  "tesseract-core.js",
  "tesseract-core.wasm",
  "tesseract-core-lstm.js",
  "tesseract-core-lstm.wasm",
  "tesseract-core-simd.js",
  "tesseract-core-simd.wasm",
  "tesseract-core-simd-lstm.js",
  "tesseract-core-simd-lstm.wasm",
];

for (const source of [workerSource, languageSource, ...coreFiles.map((file) => resolve(coreRoot, file))]) {
  if (!existsSync(source)) throw new Error(`Missing pinned receipt OCR asset: ${source}`);
}

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(resolve(outputRoot, "core"), { recursive: true });
mkdirSync(resolve(outputRoot, "lang"), { recursive: true });
cpSync(workerSource, resolve(outputRoot, "worker.min.js"));
for (const file of coreFiles) cpSync(resolve(coreRoot, file), resolve(outputRoot, "core", file));
cpSync(languageSource, resolve(outputRoot, "lang", "eng.traineddata.gz"));
