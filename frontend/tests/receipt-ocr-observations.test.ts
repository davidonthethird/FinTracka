import { beforeEach, describe, expect, it, vi } from "vitest";

const { predict, dispose, create } = vi.hoisted(() => {
  const predict = vi.fn();
  const dispose = vi.fn();
  return { predict, dispose, create: vi.fn(async () => ({ predict, dispose })) };
});

vi.mock("@paddleocr/paddleocr-js", () => ({ PaddleOCR: { create } }));

import { createReceiptOcrEngine } from "../src/viewer/receipts/receiptOcr";

describe("receipt OCR observations", () => {
  beforeEach(() => { create.mockClear(); predict.mockReset(); dispose.mockReset(); });

  it("preserves Paddle line confidence and polygon position for receipt parsing", async () => {
    predict.mockResolvedValue([{ image: { width: 600, height: 1_000 }, items: [
      { text: "LOWE'S HOME CENTERS, LLC", score: 0.96,
        poly: [[20, 40], [580, 40], [580, 90], [20, 90]] },
      { text: "TOTAL 24.99", score: 0.91,
        poly: [[300, 900], [580, 900], [580, 950], [300, 950]] },
    ] }]);
    const engine = createReceiptOcrEngine();

    const [page] = await engine.recognize(
      [{ id: "page-1", image: new Blob(["fixture"], { type: "image/jpeg" }) }],
      new AbortController().signal,
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      lang: "en", ocrVersion: "PP-OCRv6", worker: true,
      textDetectionModelAsset: { url: "/receipt-ocr/models/PP-OCRv6_small_det.tar" },
      textRecognitionModelAsset: { url: "/receipt-ocr/models/PP-OCRv6_small_rec.tar" },
    }));
    expect(predict).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({
      textDetLimitSideLen: 3_200, textRecScoreThresh: 0.05,
    }));
    expect(page).toMatchObject({ text: "LOWE'S HOME CENTERS, LLC\nTOTAL 24.99", confidence_basis_points: 9_350 });
    expect(page.observations).toEqual([
      { id: "page-1-line-0", text: "LOWE'S HOME CENTERS, LLC", confidence_basis_points: 9_600,
        bbox: { x: 20, y: 40, width: 560, height: 50 }, relative_y: 0.04 },
      { id: "page-1-line-1", text: "TOTAL 24.99", confidence_basis_points: 9_100,
        bbox: { x: 300, y: 900, width: 280, height: 50 }, relative_y: 0.9 },
    ]);
  });

  it("stops between pages after cancellation and disposes the worker", async () => {
    const controller = new AbortController();
    predict.mockImplementationOnce(async () => {
      controller.abort();
      return [{ image: { width: 10, height: 10 }, items: [] }];
    });
    const engine = createReceiptOcrEngine();

    await expect(engine.recognize([
      { id: "one", image: new Blob(["one"]) },
      { id: "two", image: new Blob(["two"]) },
    ], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(predict).toHaveBeenCalledTimes(1);

    await engine.terminate();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
