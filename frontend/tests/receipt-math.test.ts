import { describe, expect, it } from "vitest";

import { allocateMinor, reconcileReceipt } from "../src/viewer/receipts/receiptMath";

describe("allocateMinor", () => {
  it("uses largest remainders and stable line order for the final cents", () => {
    expect(allocateMinor(7, [
      { id: "first", basis_minor: 5_000 },
      { id: "second", basis_minor: 2_500 },
      { id: "third", basis_minor: 2_500 },
    ])).toEqual([
      { id: "first", amount_minor: 3 },
      { id: "second", amount_minor: 2 },
      { id: "third", amount_minor: 2 },
    ]);
  });

  it("returns zero allocations for a zero total even with zero bases", () => {
    expect(allocateMinor(0, [
      { id: "a", basis_minor: 0 },
      { id: "b", basis_minor: 0 },
    ])).toEqual([
      { id: "a", amount_minor: 0 },
      { id: "b", amount_minor: 0 },
    ]);
  });

  it.each([
    ["negative total", -1, [{ id: "a", basis_minor: 1 }]],
    ["negative basis", 1, [{ id: "a", basis_minor: -1 }]],
    ["fractional total", 1.2, [{ id: "a", basis_minor: 1 }]],
    ["fractional basis", 1, [{ id: "a", basis_minor: 1.2 }]],
    ["positive total without a basis", 1, [{ id: "a", basis_minor: 0 }]],
  ])("rejects %s", (_label, total, bases) => {
    expect(() => allocateMinor(total as number, bases)).toThrow();
  });
});

describe("reconcileReceipt", () => {
  it("allocates receipt tax only to taxable post-discount items and tip to all items", () => {
    const result = reconcileReceipt({
      lines: [
        { id: "meal", item_total_minor: 5_000, line_discount_minor: 0, taxable: true },
        { id: "drink", item_total_minor: 2_500, line_discount_minor: 0, taxable: true },
        { id: "gift", item_total_minor: 2_500, line_discount_minor: 0, taxable: false },
      ],
      receipt_discount_minor: 0,
      tax_minor: 750,
      tip_minor: 1_000,
      fees_minor: 0,
      total_minor: 11_750,
    });

    expect(result.lines).toEqual([
      { id: "meal", receipt_discount_minor: 0, tax_minor: 500, tip_minor: 500, fees_minor: 0, final_minor: 6_000 },
      { id: "drink", receipt_discount_minor: 0, tax_minor: 250, tip_minor: 250, fees_minor: 0, final_minor: 3_000 },
      { id: "gift", receipt_discount_minor: 0, tax_minor: 0, tip_minor: 250, fees_minor: 0, final_minor: 2_750 },
    ]);
    expect(result.calculated_total_minor).toBe(11_750);
    expect(result.difference_minor).toBe(0);
  });

  it("allocates a receipt discount before allocating tax and fees", () => {
    const result = reconcileReceipt({
      lines: [
        { id: "a", item_total_minor: 6_000, line_discount_minor: 1_000, taxable: true },
        { id: "b", item_total_minor: 4_000, line_discount_minor: 0, taxable: true },
      ],
      receipt_discount_minor: 900,
      tax_minor: 810,
      tip_minor: 0,
      fees_minor: 90,
      total_minor: 9_000,
    });

    expect(result.lines).toEqual([
      { id: "a", receipt_discount_minor: 500, tax_minor: 450, tip_minor: 0, fees_minor: 50, final_minor: 5_000 },
      { id: "b", receipt_discount_minor: 400, tax_minor: 360, tip_minor: 0, fees_minor: 40, final_minor: 4_000 },
    ]);
    expect(result.difference_minor).toBe(0);
  });

  it("reports the exact signed difference instead of hiding a mismatch", () => {
    const result = reconcileReceipt({
      lines: [{ id: "a", item_total_minor: 500, line_discount_minor: 0, taxable: true }],
      receipt_discount_minor: 0,
      tax_minor: 40,
      tip_minor: 0,
      fees_minor: 0,
      total_minor: 550,
    });
    expect(result.calculated_total_minor).toBe(540);
    expect(result.difference_minor).toBe(10);
  });

  it("rejects tax when no positive taxable post-discount basis exists", () => {
    expect(() => reconcileReceipt({
      lines: [{ id: "exempt", item_total_minor: 500, line_discount_minor: 0, taxable: false }],
      receipt_discount_minor: 0,
      tax_minor: 1,
      tip_minor: 0,
      fees_minor: 0,
      total_minor: 501,
    })).toThrow("tax allocation requires a positive taxable basis");
  });
});
