import { describe, expect, it } from "vitest";

import type { RemoteTransaction } from "../src/viewer/model";
import { receiptCandidates } from "../src/viewer/receipts/receiptMatching";
import type { ReceiptDraft } from "../src/viewer/receipts/types";

describe("receipt matching candidates", () => {
  it("keeps only exact posted amount/currency/date candidates and never selects one", () => {
    const draft = receipt();
    const values = [
      transaction("best", { merchant: "Synthetic Market", local_date: "2026-11-01" }),
      transaction("also", { merchant: "Different", local_date: "2026-11-02" }),
      transaction("wrong-amount", { amount_minor: -999 }),
      transaction("pending", { pending: true }),
      transaction("old", { local_date: "2026-10-01" }),
      transaction("legacy", { split_revision: undefined }),
    ];
    const result = receiptCandidates(draft, values);
    expect(result.map((item) => item.transaction.id)).toEqual(["best", "also"]);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });
});

function receipt(): ReceiptDraft {
  return { id: "draft", revision: 1, digest: "a".repeat(64), created_at: "", updated_at: "",
    retention_at: "", contract: "receipt_draft/v1", status: "waiting_for_bank",
    merchant: "Synthetic Market", purchase_date: "2026-11-01", currency: "USD",
    masked_payment_hint: null, page_count: 1, subtotal_minor: 1000, discount_minor: 0,
    tax_minor: 0, tip_minor: 0, fees_minor: 0, total_minor: 1000, lines: [] };
}

function transaction(id: string, changes: Record<string, unknown> = {}): RemoteTransaction {
  return { id, local_date: "2026-11-01", amount_minor: -1000, currency: "USD",
    description: "Synthetic", merchant: "Synthetic", category_id: null, category: null,
    subcategory_id: null, subcategory: null, spending_owner: "Shared", account_name: "Checking",
    account_type: "depository", account_subtype: "checking", account_mask: "0000",
    institution_name: "Bank", pending: false, manual_cash: false, is_cash_withdrawal: false,
    updated_at: "2026-11-01T12:00:00Z", classification_revision: 0, split_revision: 0,
    ...changes } as RemoteTransaction;
}
