import { beforeEach, describe, expect, it, vi } from "vitest";

const recognize = vi.fn();
const terminate = vi.fn();

vi.mock("tesseract.js", () => ({
  OEM: { LSTM_ONLY: 1 },
  createWorker: vi.fn(async () => ({ recognize, terminate })),
}));

import { createReceiptOcrEngine } from "../src/viewer/receipts/receiptOcr";

describe("receipt OCR observations", () => {
  beforeEach(() => { recognize.mockReset(); terminate.mockReset(); });

  it("preserves Tesseract line confidence and position for receipt parsing", async () => {
    recognize.mockResolvedValue({ data: {
      text: "LOWE'S HOME CENTERS, LLC\nTOTAL 24.99\n",
      confidence: 88,
      blocks: [{ bbox: { x0: 5, y0: 10, x1: 600, y1: 1_000 }, paragraphs: [{ lines: [
        { text: "LOWE'S HOME CENTERS, LLC", confidence: 96,
          bbox: { x0: 20, y0: 40, x1: 580, y1: 90 } },
        { text: "TOTAL 24.99", confidence: 91,
          bbox: { x0: 300, y0: 900, x1: 580, y1: 950 } },
      ] }] }],
    } });
    const engine = createReceiptOcrEngine();

    const [page] = await engine.recognize(
      [{ id: "page-1", image: new Blob(["fixture"], { type: "image/jpeg" }) }],
      new AbortController().signal,
    );

    expect(page.observations).toEqual([
      { id: "page-1-line-0", text: "LOWE'S HOME CENTERS, LLC", confidence_basis_points: 9_600,
        bbox: { x: 20, y: 40, width: 560, height: 50 }, relative_y: 0.04 },
      { id: "page-1-line-1", text: "TOTAL 24.99", confidence_basis_points: 9_100,
        bbox: { x: 300, y: 900, width: 280, height: 50 }, relative_y: 0.9 },
    ]);
  });
});
