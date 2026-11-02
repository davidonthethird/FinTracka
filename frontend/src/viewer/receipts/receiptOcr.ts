import type { OcrResult, Point2D } from "@paddleocr/paddleocr-js";

import type {
  OcrReceiptPage,
  PreparedReceiptPage,
  ReceiptOcrEngine,
  ReceiptOcrProgress,
} from "./types";

export const RECEIPT_OCR_DETECTION_MODEL_URL = "/receipt-ocr/models/PP-OCRv6_small_det.tar";
export const RECEIPT_OCR_RECOGNITION_MODEL_URL = "/receipt-ocr/models/PP-OCRv6_small_rec.tar";
export const RECEIPT_OCR_RUNTIME_PATH = "/receipt-ocr/ort/";

type ProgressHandler = (progress: ReceiptOcrProgress) => void;
type PaddleModule = typeof import("@paddleocr/paddleocr-js");
type PaddleEngine = Awaited<ReturnType<PaddleModule["PaddleOCR"]["create"]>>;

function abortError(): DOMException {
  return new DOMException("Receipt recognition was cancelled", "AbortError");
}

class PaddleReceiptOcrEngine implements ReceiptOcrEngine {
  private engine?: PaddleEngine;
  private enginePromise?: Promise<PaddleEngine>;

  constructor(private readonly onProgress?: ProgressHandler) {}

  private getEngine(): Promise<PaddleEngine> {
    if (this.engine) return Promise.resolve(this.engine);
    if (!this.enginePromise) {
      this.enginePromise = import("@paddleocr/paddleocr-js").then(({ PaddleOCR }) => PaddleOCR.create({
        lang: "en",
        ocrVersion: "PP-OCRv6",
        textDetectionModelName: "PP-OCRv6_small_det",
        textDetectionModelAsset: { url: RECEIPT_OCR_DETECTION_MODEL_URL },
        textRecognitionModelName: "PP-OCRv6_small_rec",
        textRecognitionModelAsset: { url: RECEIPT_OCR_RECOGNITION_MODEL_URL },
        worker: true,
        ortOptions: { backend: "wasm", wasmPaths: RECEIPT_OCR_RUNTIME_PATH, numThreads: 1, simd: true },
      })).then((engine) => {
        this.engine = engine;
        return engine;
      }).finally(() => { this.enginePromise = undefined; });
    }
    return this.enginePromise;
  }

  async recognize(pages: PreparedReceiptPage[], signal: AbortSignal): Promise<OcrReceiptPage[]> {
    if (signal.aborted) throw abortError();
    const engine = await this.getEngine();
    if (signal.aborted) throw abortError();
    const results: OcrReceiptPage[] = [];
    for (const [pageIndex, page] of pages.entries()) {
      if (signal.aborted) throw abortError();
      this.onProgress?.({ page_index: pageIndex, page_count: pages.length,
        status: "reading receipt", progress_basis_points: 0 });
      const [result] = await engine.predict(page.image, {
        textDetLimitSideLen: 3_200,
        textDetMaxSideLimit: 4_000,
        textDetThresh: 0.2,
        textDetBoxThresh: 0.4,
        textDetUnclipRatio: 1.8,
        textRecScoreThresh: 0.05,
      });
      if (signal.aborted) throw abortError();
      results.push(pageFromResult(page.id, pageIndex, result));
      this.onProgress?.({ page_index: pageIndex, page_count: pages.length,
        status: "page complete", progress_basis_points: 10_000 });
    }
    return results;
  }

  async terminate(): Promise<void> {
    const engine = this.engine ?? await this.enginePromise;
    this.engine = undefined;
    this.enginePromise = undefined;
    if (engine) await engine.dispose();
  }
}

function pageFromResult(id: string, pageIndex: number, result: OcrResult): OcrReceiptPage {
  const items = result.items.filter((item) => item.text.trim().length > 0);
  const confidence = items.length
    ? Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length * 10_000)
    : 0;
  return {
    id,
    page_index: pageIndex,
    text: items.map((item) => item.text.trim()).join("\n"),
    confidence_basis_points: clampBasisPoints(confidence),
    observations: items.map((item, index) => {
      const bounds = polygonBounds(item.poly);
      return {
        id: `${id}-line-${index}`,
        text: item.text.trim(),
        confidence_basis_points: clampBasisPoints(Math.round(item.score * 10_000)),
        bbox: bounds,
        relative_y: Math.max(0, Math.min(1, bounds.y / Math.max(1, result.image.height))),
      };
    }),
  };
}

function polygonBounds(poly: Point2D[]) {
  const xs = poly.map(([x]) => x);
  const ys = poly.map(([, y]) => y);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function clampBasisPoints(value: number): number {
  return Math.max(0, Math.min(10_000, value));
}

export function createReceiptOcrEngine(onProgress?: ProgressHandler): ReceiptOcrEngine {
  return new PaddleReceiptOcrEngine(onProgress);
}
