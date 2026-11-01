import { describe, expect, it } from "vitest";

import { parseReceiptPages } from "../src/viewer/receipts/receiptParser";
import type { OcrReceiptPage } from "../src/viewer/receipts/types";

describe("receipt parser", () => {
  it("extracts merchant, date, lines, and totals with source confidence", () => {
    const result = parseReceiptPages([page(0, [
      observation("merchant", "SYNTHETIC MARKET", 20, 0.02),
      observation("date", "11/01/2026", 100, 0.08),
      observation("apple", "APPLES 4.50", 300, 0.21),
      observation("bread", "BREAD 3.25", 360, 0.26),
      observation("subtotal", "SUBTOTAL 7.75", 900, 0.70),
      observation("tax", "TAX 0.52", 960, 0.75),
      observation("total", "TOTAL 8.27", 1040, 0.82),
    ])]);
    expect(result).toMatchObject({
      merchant: { value: "SYNTHETIC MARKET" },
      purchase_date: { value: "2026-11-01" },
      subtotal_minor: { value: 775 }, tax_minor: { value: 52 }, total_minor: { value: 827 },
    });
    expect(result.lines.map((line) => [line.description, line.item_total_minor]))
      .toEqual([["APPLES", 450], ["BREAD", 325]]);
    expect(result.lines[0].confidence_basis_points).toBe(9_000);
  });

  it("collapses only exact adjacent boundary overlaps", () => {
    const result = parseReceiptPages([
      page(0, [
        observation("a", "APPLE 4.50", 900, 0.90),
        observation("overlap-1", "SOAP 5.00", 1100, 0.96),
      ]),
      page(1, [
        observation("overlap-2", "SOAP 5.00", 20, 0.02),
        observation("b", "MILK 4.25", 300, 0.25),
      ]),
    ]);
    expect(result.lines.map((line) => line.description)).toEqual(["APPLE", "SOAP", "MILK"]);
    expect(result.collapsed_observation_ids).toEqual(["overlap-2"]);
  });

  it("groups uncertain similar overlaps and preserves legitimate repeated items", () => {
    const uncertain = parseReceiptPages([
      page(0, [observation("left", "COFFEE 8.99", 1100, 0.96)]),
      page(1, [observation("right", "COFEEE 8.99", 20, 0.02)]),
    ]);
    expect(uncertain.lines).toHaveLength(2);
    expect(uncertain.overlap_groups).toEqual([{ id: "overlap-1", observation_ids: ["left", "right"] }]);

    const repeated = parseReceiptPages([page(0, [
      observation("one", "WATER 2.00", 300, 0.2),
      observation("two", "WATER 2.00", 500, 0.4),
    ])]);
    expect(repeated.lines).toHaveLength(2);
    expect(repeated.overlap_groups).toEqual([]);
  });

  it("extracts discounts, tips, and service fees without turning them into products", () => {
    const result = parseReceiptPages([page(0, [
      observation("merchant", "CAFE FIXTURE", 10, 0.01),
      observation("meal", "MEAL 20.00", 100, 0.10),
      observation("drink", "DRINK 5.00", 200, 0.20),
      observation("discount", "DISCOUNT -2.00", 300, 0.30),
      observation("tax", "TAX 1.50", 400, 0.40),
      observation("tip", "TIP 4.00", 500, 0.50),
      observation("fee", "SERVICE FEE 1.00", 600, 0.60),
      observation("total", "TOTAL 29.50", 900, 0.90),
    ])]);
    expect(result).toMatchObject({ discount_minor: { value: 200 }, tax_minor: { value: 150 },
      tip_minor: { value: 400 }, fees_minor: { value: 100 }, total_minor: { value: 2950 } });
    expect(result.lines.map((line) => line.description)).toEqual(["MEAL", "DRINK"]);
  });

  it("keeps exempt grocery markers and missing-subtotal receipts visibly reviewable", () => {
    const result = parseReceiptPages([page(0, [
      observation("merchant", "GROCERY FIXTURE", 10, 0.01),
      observation("milk", "MILK E 4.00", 200, 0.20),
      observation("milk-again", "MILK E 4.00", 300, 0.30),
      observation("total", "TOTAL 8.00", 900, 0.90),
    ])]);
    expect(result.subtotal_minor).toBeUndefined();
    expect(result.lines).toMatchObject([
      { description: "MILK E", item_total_minor: 400 },
      { description: "MILK E", item_total_minor: 400 },
    ]);
    expect(result.overlap_groups).toEqual([]);
  });
});

function observation(id: string, text: string, y: number, relativeY: number) {
  return { id, text, confidence_basis_points: 9_000,
    bbox: { x: 10, y, width: 500, height: 40 }, relative_y: relativeY };
}

function page(index: number, observations: ReturnType<typeof observation>[]): OcrReceiptPage {
  return { id: `page-${index}`, page_index: index, text: observations.map((item) => item.text).join("\n"),
    confidence_basis_points: 9_000, observations };
}
