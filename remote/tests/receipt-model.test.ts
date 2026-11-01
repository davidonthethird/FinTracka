import { describe, expect, it } from "vitest";

import {
  ReceiptDraftV1Schema,
  canonicalReceiptRevision,
  receiptRevisionDigest,
} from "../src/receiptModel";

describe("receipt draft model", () => {
  it("strictly validates exact-cent ownership drafts", () => {
    expect(ReceiptDraftV1Schema.parse(draft())).toMatchObject({
      contract: "receipt_draft/v1",
      lines: [{ owner: "Shared", item_total_minor: 1_000 }],
    });
    expect(() => ReceiptDraftV1Schema.parse({ ...draft(), image: "not-allowed" })).toThrow();
    expect(() => ReceiptDraftV1Schema.parse({ ...draft(), total_minor: 10.5 })).toThrow();
    expect(() => ReceiptDraftV1Schema.parse({ ...draft(), lines: [{ ...draft().lines[0], owner: "Nobody" }] })).toThrow();
    expect(() => ReceiptDraftV1Schema.parse({ ...draft(), page_count: 13 })).toThrow();
    expect(() => ReceiptDraftV1Schema.parse({ ...draft(), lines: Array.from({ length: 251 }, (_, index) => ({
      ...draft().lines[0], id: `line-${index}`, order: index,
    })) })).toThrow();
  });

  it("produces a stable canonical body and digest independent of object key order", async () => {
    const first = draft();
    const reordered = Object.fromEntries(Object.entries(first).reverse());
    expect(canonicalReceiptRevision(first)).toBe(canonicalReceiptRevision(reordered));
    expect(await receiptRevisionDigest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(await receiptRevisionDigest(first)).toBe(await receiptRevisionDigest(reordered));
  });
});

export function draft() {
  return {
    contract: "receipt_draft/v1" as const,
    status: "waiting_for_bank" as const,
    merchant: "Synthetic Market",
    purchase_date: "2026-11-01",
    currency: "USD",
    masked_payment_hint: null,
    page_count: 1,
    subtotal_minor: 1_000,
    discount_minor: 0,
    tax_minor: 0,
    tip_minor: 0,
    fees_minor: 0,
    total_minor: 1_000,
    lines: [{
      id: "line-1",
      order: 0,
      source_page: 0,
      description: "Synthetic item",
      quantity: "1",
      unit_amount_minor: 1_000,
      item_total_minor: 1_000,
      line_discount_minor: 0,
      tax_minor: 0,
      tip_minor: 0,
      fees_minor: 0,
      taxable: true,
      owner: "Shared" as const,
      category_id: null,
      subcategory_id: null,
      confidence_basis_points: 9_500,
      review_flags: [],
    }],
  };
}
