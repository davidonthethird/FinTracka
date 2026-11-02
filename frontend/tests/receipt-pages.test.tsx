import { renderToStaticMarkup } from "react-dom/server";
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReceiptInboxView } from "../src/viewer/receipts/ReceiptInboxPage";
import { ReceiptCapturePage } from "../src/viewer/receipts/ReceiptCapturePage";
import { ReceiptProvider } from "../src/viewer/receipts/ReceiptProvider";
import { ReceiptReviewForm } from "../src/viewer/receipts/ReceiptReviewPage";
import { createReceipt, replaceReceipt } from "../src/viewer/receipts/receiptApi";
import type { ReceiptDraft } from "../src/viewer/receipts/types";

afterEach(() => vi.unstubAllGlobals());

describe("receipt API and pages", () => {
  it("uses same-origin structured JSON without image fields", async () => {
    const fetchMock = vi.fn(async (_path: string, init: RequestInit) => new Response(JSON.stringify({
      draft: { ...draft(), id: "receipt-1", revision: 1, digest: "a".repeat(64),
        created_at: "2026-11-01", updated_at: "2026-11-01", retention_at: "2027-01-30" }, replayed: false,
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await createReceipt(draft(), "receipt-create-001");
    const [path, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
    expect(path).toBe("/api/v1/mobile/receipts");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).not.toContain("image");
  });

  it("sends optimistic revision when saving a reviewed receipt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ draft: {
      ...draft(), id: "receipt-1", revision: 2, digest: "b".repeat(64),
      created_at: "2026-11-01", updated_at: "2026-11-01", retention_at: "2027-01-30",
    }, replayed: false }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await replaceReceipt("receipt-1", 1, draft(), "receipt-update-001");
    const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toMatchObject({ expected_revision: 1 });
  });

  it("labels unmatched drafts as nonfinancial and exposes A/D/S review controls", () => {
    const receipt = persistedDraft();
    const inbox = renderToStaticMarkup(<ReceiptInboxView drafts={[receipt]} onOpen={() => undefined} onNew={() => undefined} />);
    expect(inbox).toContain("No spending has been added");
    const review = renderToStaticMarkup(<ReceiptReviewForm draft={receipt} taxonomy={null}
      saving={false} onSave={() => undefined} onChange={() => undefined} />);
    expect(review).toContain("David");
    expect(review).toContain("Ariela");
    expect(review).toContain("Shared");
    expect(review).toContain("Save and wait for bank transaction");
  });

  it("prepares a native iPhone Shortcut handoff without browser file inputs", () => {
    const html = renderToStaticMarkup(
      <ReceiptProvider><ReceiptCapturePage navigate={() => undefined} /></ReceiptProvider>,
    );
    expect(html).toContain("Preparing secure scan");
    expect(html).toContain("photos stay on your iPhone");
    expect(html).not.toContain("type=\"file\"");
  });
});

function draft() {
  return {
    contract: "receipt_draft/v1" as const, status: "editing" as const,
    merchant: "Synthetic Market", purchase_date: "2026-11-01", currency: "USD",
    masked_payment_hint: null, page_count: 1, subtotal_minor: 1_000, discount_minor: 0,
    tax_minor: 0, tip_minor: 0, fees_minor: 0, total_minor: 1_000,
    lines: [{ id: "line-1", order: 0, source_page: 0, description: "Item", quantity: "1",
      unit_amount_minor: 1_000, item_total_minor: 1_000, line_discount_minor: 0,
      tax_minor: 0, tip_minor: 0, fees_minor: 0, taxable: true, owner: "Shared" as const,
      category_id: null, subcategory_id: null, confidence_basis_points: 9_000, review_flags: [] }],
  };
}

function persistedDraft(): ReceiptDraft {
  return { ...draft(), id: "receipt-1", revision: 1, digest: "a".repeat(64),
    created_at: "2026-11-01", updated_at: "2026-11-01", retention_at: "2027-01-30" };
}
