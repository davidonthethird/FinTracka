import { reconcileReceipt } from "./receiptMath";
import type { ParsedReceiptCandidate } from "./receiptParser";
import type { ReceiptDraftV1 } from "./types";

export function isUsableParsedReceipt(parsed: ParsedReceiptCandidate): boolean {
  return Boolean(parsed.merchant || parsed.total_minor || parsed.lines.length);
}

export function draftFromParsedReceipt(parsed: ParsedReceiptCandidate, pageCount: number): ReceiptDraftV1 {
  if (!isUsableParsedReceipt(parsed)) throw new Error("No usable receipt text was recognized.");
  const bases = parsed.lines.map((line) => ({ id: line.id, item_total_minor: line.item_total_minor,
    line_discount_minor: 0, taxable: true }));
  const total = parsed.total_minor?.value ?? parsed.lines.reduce((sum, line) => sum + line.item_total_minor, 0);
  let allocated = new Map<string, ReturnType<typeof reconcileReceipt>["lines"][number]>();
  try {
    allocated = new Map(reconcileReceipt({ lines: bases,
      receipt_discount_minor: parsed.discount_minor?.value ?? 0,
      tax_minor: parsed.tax_minor?.value ?? 0, tip_minor: parsed.tip_minor?.value ?? 0,
      fees_minor: parsed.fees_minor?.value ?? 0, total_minor: total })
      .lines.map((line) => [line.id, line]));
  } catch { /* review remains visibly unreconciled */ }
  return { contract: "receipt_draft/v1", status: "editing",
    merchant: parsed.merchant?.value ?? "", purchase_date: parsed.purchase_date?.value ?? null,
    currency: "USD", masked_payment_hint: null, page_count: pageCount,
    subtotal_minor: parsed.subtotal_minor?.value ?? bases.reduce((sum, line) => sum + line.item_total_minor, 0),
    discount_minor: parsed.discount_minor?.value ?? 0, tax_minor: parsed.tax_minor?.value ?? 0,
    tip_minor: parsed.tip_minor?.value ?? 0, fees_minor: parsed.fees_minor?.value ?? 0,
    total_minor: total, lines: parsed.lines.map((line, index) => ({ id: line.id, order: index,
      source_page: line.page_index, description: line.description, quantity: "1",
      unit_amount_minor: line.item_total_minor, item_total_minor: line.item_total_minor,
      line_discount_minor: allocated.get(line.id)?.receipt_discount_minor ?? 0,
      tax_minor: allocated.get(line.id)?.tax_minor ?? 0,
      tip_minor: allocated.get(line.id)?.tip_minor ?? 0,
      fees_minor: allocated.get(line.id)?.fees_minor ?? 0, taxable: true, owner: "Shared", category_id: null,
      subcategory_id: null, confidence_basis_points: line.confidence_basis_points,
      review_flags: [...line.review_flags,
        ...(parsed.overlap_groups.some((group) => group.observation_ids.includes(line.observation_id))
          ? ["possible_duplicate"] : [])] })) };
}
