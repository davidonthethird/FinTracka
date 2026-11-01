import { createWorker, OEM, type LoggerMessage, type Worker } from "tesseract.js";

import type {
  OcrReceiptPage,
  PreparedReceiptPage,
  ReceiptOcrEngine,
  ReceiptOcrProgress,
} from "./types";

export const RECEIPT_OCR_WORKER_PATH = "/receipt-ocr/worker.min.js";
export const RECEIPT_OCR_CORE_PATH = "/receipt-ocr/core";
export const RECEIPT_OCR_LANGUAGE_PATH = "/receipt-ocr/lang";

type ProgressHandler = (progress: ReceiptOcrProgress) => void;

function abortError(): DOMException {
  return new DOMException("Receipt recognition was cancelled", "AbortError");
}

class TesseractReceiptOcrEngine implements ReceiptOcrEngine {
  private worker?: Worker;
  private workerPromise?: Promise<Worker>;
  private activePage = 0;
  private pageCount = 0;

  constructor(private readonly onProgress?: ProgressHandler) {}

  private getWorker(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker);
    if (!this.workerPromise) {
      this.workerPromise = createWorker("eng", OEM.LSTM_ONLY, {
        workerPath: RECEIPT_OCR_WORKER_PATH,
        corePath: RECEIPT_OCR_CORE_PATH,
        langPath: RECEIPT_OCR_LANGUAGE_PATH,
        logger: (message: LoggerMessage) => this.reportProgress(message),
      }).then((worker) => {
        this.worker = worker;
        return worker;
      }).finally(() => {
        this.workerPromise = undefined;
      });
    }
    return this.workerPromise;
  }

  private reportProgress(message: LoggerMessage): void {
    this.onProgress?.({
      page_index: this.activePage,
      page_count: this.pageCount,
      status: message.status,
      progress_basis_points: Math.max(0, Math.min(10_000, Math.round(message.progress * 10_000))),
    });
  }

  async recognize(pages: PreparedReceiptPage[], signal: AbortSignal): Promise<OcrReceiptPage[]> {
    if (signal.aborted) throw abortError();
    this.pageCount = pages.length;
    const worker = await this.getWorker();
    const abort = () => { void this.terminate(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const results: OcrReceiptPage[] = [];
      for (const [pageIndex, page] of pages.entries()) {
        if (signal.aborted) throw abortError();
        this.activePage = pageIndex;
        const result = await worker.recognize(page.image);
        if (signal.aborted) throw abortError();
        results.push({
          id: page.id,
          page_index: pageIndex,
          text: result.data.text,
          confidence_basis_points: Math.max(0, Math.min(10_000, Math.round(result.data.confidence * 100))),
        });
      }
      return results;
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async terminate(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
}

export function createReceiptOcrEngine(onProgress?: ProgressHandler): ReceiptOcrEngine {
  return new TesseractReceiptOcrEngine(onProgress);
}
