import { z } from "zod";

const minor = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nullableId = z.string().min(1).max(128).nullable();
const quantity = z.string().regex(/^\d{1,6}(?:\.\d{1,3})?$/);

export const receiptStatuses = [
  "editing", "waiting_for_bank", "match_pending", "processing",
  "matched", "conflict", "dismissed",
] as const;

export const ReceiptLineV1Schema = z.object({
  id: z.string().min(1).max(128),
  order: z.int().min(0).max(249),
  source_page: z.int().min(0).max(11).nullable(),
  description: z.string().trim().min(1).max(200),
  quantity,
  unit_amount_minor: minor.nullable(),
  item_total_minor: minor,
  line_discount_minor: minor,
  tax_minor: minor,
  tip_minor: minor,
  fees_minor: minor,
  taxable: z.boolean(),
  owner: z.enum(["David", "Ariela", "Shared"]),
  category_id: nullableId,
  subcategory_id: nullableId,
  confidence_basis_points: z.int().min(0).max(10_000),
  review_flags: z.array(z.string().min(1).max(40)).max(8),
}).strict().superRefine((line, context) => {
  if (line.line_discount_minor > line.item_total_minor) {
    context.addIssue({ code: "custom", path: ["line_discount_minor"], message: "discount exceeds item" });
  }
  if (line.category_id === null && line.subcategory_id !== null) {
    context.addIssue({ code: "custom", path: ["subcategory_id"], message: "subcategory requires category" });
  }
});

export const ReceiptDraftV1Schema = z.object({
  contract: z.literal("receipt_draft/v1"),
  status: z.enum(receiptStatuses),
  merchant: z.string().trim().max(160),
  purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  masked_payment_hint: z.string().trim().min(1).max(24).nullable(),
  page_count: z.int().min(0).max(12),
  subtotal_minor: minor,
  discount_minor: minor,
  tax_minor: minor,
  tip_minor: minor,
  fees_minor: minor,
  total_minor: minor,
  lines: z.array(ReceiptLineV1Schema).max(250),
}).strict().superRefine((draft, context) => {
  const ids = new Set<string>();
  const orders = new Set<number>();
  draft.lines.forEach((line, index) => {
    if (ids.has(line.id)) context.addIssue({ code: "custom", path: ["lines", index, "id"], message: "duplicate line id" });
    if (orders.has(line.order)) context.addIssue({ code: "custom", path: ["lines", index, "order"], message: "duplicate line order" });
    if (line.source_page !== null && line.source_page >= draft.page_count) {
      context.addIssue({ code: "custom", path: ["lines", index, "source_page"], message: "page out of range" });
    }
    ids.add(line.id); orders.add(line.order);
  });
});

export const CreateReceiptDraftSchema = z.object({
  idempotency_key: z.string().min(8).max(128),
  draft: ReceiptDraftV1Schema,
}).strict();

export const ReplaceReceiptDraftSchema = z.object({
  expected_revision: z.int().min(1),
  idempotency_key: z.string().min(8).max(128),
  draft: ReceiptDraftV1Schema,
}).strict();

export type ReceiptDraftV1 = z.infer<typeof ReceiptDraftV1Schema>;
export type CreateReceiptDraft = z.infer<typeof CreateReceiptDraftSchema>;
export type ReplaceReceiptDraft = z.infer<typeof ReplaceReceiptDraftSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function canonicalReceiptRevision(value: unknown): string {
  return JSON.stringify(canonicalize(ReceiptDraftV1Schema.parse(value)));
}

export async function receiptRevisionDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalReceiptRevision(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
