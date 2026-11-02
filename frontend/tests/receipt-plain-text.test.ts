import { describe, expect, it } from "vitest";

import { draftFromParsedReceipt, isUsableParsedReceipt } from "../src/viewer/receipts/receiptDraftBuilder";
import { receiptPagesFromPlainText } from "../src/viewer/receipts/receiptPlainText";
import { parseReceiptPages, type ParsedReceiptCandidate } from "../src/viewer/receipts/receiptParser";

describe("Apple Vision receipt text adapter", () => {
  it("normalizes line endings and non-breaking spaces while preserving page and line order", () => {
    const pages = receiptPagesFromPlainText([
      { page_index: 1, text: "SECOND\r\n\r\nPAGE" },
      { page_index: 0, text: "  FIRST\u00a0PAGE \rLINE TWO\n   " },
    ]);

    expect(pages.map((page) => [page.page_index, page.text])).toEqual([
      [0, "FIRST PAGE\nLINE TWO"],
      [1, "SECOND\nPAGE"],
    ]);
    expect(pages[0].observations?.map((item) => item.text)).toEqual(["FIRST PAGE", "LINE TWO"]);
  });

  it("places a following money-only line on the description row", () => {
    const [page] = receiptPagesFromPlainText([{ page_index: 0, text: "HAND BAG\n$35.00\nTOTAL\n$38.11" }]);
    const observations = page.observations ?? [];

    expect(observations.map((item) => item.text)).toEqual(["HAND BAG", "$35.00", "TOTAL", "$38.11"]);
    expect(observations[0].bbox.y).toBe(observations[1].bbox.y);
    expect(observations[1].bbox.x).toBeGreaterThan(observations[0].bbox.x);
    expect(observations[2].bbox.y).toBe(observations[3].bbox.y);
    expect(observations[2].bbox.y).toBeGreaterThan(observations[0].bbox.y);
  });

  it("keeps consecutive unrelated money-only lines on separate rows", () => {
    const [page] = receiptPagesFromPlainText([{ page_index: 0, text: "$5.00\n$6.00\nITEM\n$7.00" }]);
    const observations = page.observations ?? [];

    expect(observations[0].bbox.y).not.toBe(observations[1].bbox.y);
    expect(observations[2].bbox.y).toBe(observations[3].bbox.y);
  });

  it("keeps native text conservative and visibly reviewable", () => {
    const parsed = parseReceiptPages(receiptPagesFromPlainText([{ page_index: 0,
      text: "SYNTHETIC MARKET\nAPPLES\n4.50\nTOTAL\n4.50" }]));

    expect(parsed.lines).toMatchObject([{ description: "APPLES", item_total_minor: 450,
      review_flags: ["low_ocr_confidence"] }]);
    expect(parsed.lines[0].confidence_basis_points).toBeLessThan(8_000);
  });

  it("deduplicates repeated full-page recognized text", () => {
    const text = "SYNTHETIC MARKET\nAPPLES 4.50\nBREAD 3.25\nTOTAL 7.75";
    const parsed = parseReceiptPages(receiptPagesFromPlainText([
      { page_index: 0, text }, { page_index: 1, text },
    ]));

    expect(parsed.duplicate_page_indexes).toEqual([1]);
    expect(parsed.lines.map((line) => line.description)).toEqual(["APPLES", "BREAD"]);
  });

  it("builds the ordinary reconciled draft shape", () => {
    const parsed = parseReceiptPages(receiptPagesFromPlainText([{ page_index: 0,
      text: "SYNTHETIC MARKET\nAPPLES 4.50\nBREAD 3.25\nSUBTOTAL 7.75\nTAX 0.52\nTOTAL 8.27" }]));
    const draft = draftFromParsedReceipt(parsed, 1);

    expect(draft).toMatchObject({ contract: "receipt_draft/v1", merchant: "SYNTHETIC MARKET",
      page_count: 1, subtotal_minor: 775, tax_minor: 52, total_minor: 827 });
    expect(draft.lines.map((line) => line.item_total_minor)).toEqual([450, 325]);
    expect(draft.lines.reduce((sum, line) => sum + line.item_total_minor + line.tax_minor, 0)).toBe(827);
  });

  it("rejects recognized text that produced no merchant, total, or priced item", () => {
    const parsed: ParsedReceiptCandidate = { lines: [], overlap_groups: [],
      collapsed_observation_ids: [], duplicate_page_indexes: [] };

    expect(isUsableParsedReceipt(parsed)).toBe(false);
    expect(() => draftFromParsedReceipt(parsed, 1)).toThrow(/usable receipt/i);
  });
});
