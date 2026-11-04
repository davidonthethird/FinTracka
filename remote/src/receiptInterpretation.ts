import { z } from "zod";

const evidenceText = z.string().min(1).max(1_000);
const textField = z.object({ value: z.string().min(1).max(500), evidence: evidenceText }).strict();
const amountField = z.object({ value_cents: z.int().min(-100_000_000).max(100_000_000),
  evidence: evidenceText }).strict();
const lineField = z.object({
  description: z.string().min(1).max(500),
  amount_cents: z.int().min(-100_000_000).max(100_000_000),
  description_evidence: evidenceText,
  amount_evidence: evidenceText,
}).strict();

export const ReceiptInterpretationSchema = z.object({
  merchant: textField.nullable(),
  date: textField.nullable(),
  subtotal: amountField.nullable(),
  discounts: z.array(amountField).max(20),
  tax: amountField.nullable(),
  tip: amountField.nullable(),
  fees: z.array(amountField).max(20),
  total: amountField.nullable(),
  lines: z.array(lineField).max(200),
}).strict();

export type ReceiptInterpretation = z.infer<typeof ReceiptInterpretationSchema>;
export type ReceiptIssue = "invalid_model_result" | "unsupported_merchant" | "unsupported_date"
  | "unsupported_subtotal" | "unsupported_discount" | "unsupported_tax" | "unsupported_tip"
  | "unsupported_fee" | "unsupported_total" | "unsupported_line" | "evidence_value_mismatch"
  | "duplicate_line_evidence" | "summary_arithmetic_mismatch" | "item_arithmetic_mismatch";

export interface ReceiptValidationResult {
  status: "accepted" | "needs_review" | "needs_refinement";
  issues: ReceiptIssue[];
  receipt: ReceiptInterpretation;
}

const EMPTY: ReceiptInterpretation = {
  merchant: null, date: null, subtotal: null, discounts: [], tax: null, tip: null,
  fees: [], total: null, lines: [],
};

export function validateReceiptInterpretation(rawText: string, modelResult: string): ReceiptValidationResult {
  let untrusted: unknown;
  try { untrusted = JSON.parse(modelResult); } catch {
    return { status: "needs_refinement", issues: ["invalid_model_result"], receipt: structuredClone(EMPTY) };
  }
  const parsed = ReceiptInterpretationSchema.safeParse(untrusted);
  if (!parsed.success) {
    return { status: "needs_refinement", issues: ["invalid_model_result"], receipt: structuredClone(EMPTY) };
  }
  const issues: ReceiptIssue[] = [];
  const text = normalize(rawText);
  const rows = rawText.split(/\r?\n/).map(normalize).filter(Boolean);
  const receipt: ReceiptInterpretation = structuredClone(EMPTY);

  receipt.merchant = supportedText(parsed.data.merchant, text, "unsupported_merchant", issues);
  receipt.date = supportedDate(parsed.data.date, text, issues);
  receipt.subtotal = supportedAmount(parsed.data.subtotal, text, "unsupported_subtotal", issues);
  receipt.discounts = parsed.data.discounts.flatMap((value) => {
    const supported = supportedAmount(value, text, "unsupported_discount", issues);
    return supported ? [supported] : [];
  });
  receipt.tax = supportedAmount(parsed.data.tax, text, "unsupported_tax", issues);
  receipt.tip = supportedAmount(parsed.data.tip, text, "unsupported_tip", issues);
  receipt.fees = parsed.data.fees.flatMap((value) => {
    const supported = supportedAmount(value, text, "unsupported_fee", issues);
    return supported ? [supported] : [];
  });
  receipt.total = supportedAmount(parsed.data.total, text, "unsupported_total", issues);

  const usedEvidence = new Set<string>();
  for (const line of parsed.data.lines) {
    const descriptionEvidence = normalize(line.description_evidence);
    const amountEvidence = normalize(line.amount_evidence);
    const evidenceKey = `${descriptionEvidence}\u0000${amountEvidence}`;
    if (usedEvidence.has(evidenceKey)) {
      addIssue(issues, "duplicate_line_evidence");
      continue;
    }
    if (!descriptionEvidence || !amountEvidence || !text.includes(descriptionEvidence)
        || !text.includes(amountEvidence) || !sharesPrintedRow(rows, descriptionEvidence, amountEvidence)
        || line.amount_cents <= 0) {
      addIssue(issues, "unsupported_line");
      continue;
    }
    if (!descriptionEvidence.includes(normalize(line.description))) {
      addIssue(issues, "evidence_value_mismatch");
      continue;
    }
    if (!evidenceHasCents(amountEvidence, line.amount_cents)) {
      addIssue(issues, "evidence_value_mismatch");
      continue;
    }
    usedEvidence.add(evidenceKey);
    receipt.lines.push(line);
  }

  if (receipt.total && receipt.lines.length > 0) {
    const itemTotal = receipt.lines.reduce((sum, item) => sum + item.amount_cents, 0);
    const calculated = (receipt.subtotal?.value_cents ?? itemTotal)
      - receipt.discounts.reduce((sum, item) => sum + Math.abs(item.value_cents), 0)
      + (receipt.tax?.value_cents ?? 0) + (receipt.tip?.value_cents ?? 0)
      + receipt.fees.reduce((sum, item) => sum + item.value_cents, 0);
    if (calculated !== receipt.total.value_cents) addIssue(issues, "summary_arithmetic_mismatch");
    if (receipt.subtotal && itemTotal !== receipt.subtotal.value_cents) {
      addIssue(issues, "item_arithmetic_mismatch");
    }
  }

  const unusable = !receipt.merchant || !receipt.total || receipt.lines.length === 0;
  const material = issues.some((issue) => issue !== "unsupported_date");
  return { status: unusable || material ? "needs_refinement" : issues.length ? "needs_review" : "accepted",
    issues, receipt };
}

function supportedDate<T extends z.infer<typeof textField>>(value: T | null, raw: string,
  issues: ReceiptIssue[]): T | null {
  if (!value) return null;
  const evidence = normalize(value.evidence);
  const normalizedDate = parseDateEvidence(evidence);
  if (!evidence || !raw.includes(evidence) || !normalizedDate || normalize(value.value) !== normalizedDate) {
    addIssue(issues, "unsupported_date");
    return null;
  }
  return { ...value, value: normalizedDate };
}

function parseDateEvidence(evidence: string): string | null {
  const iso = evidence.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const us = evidence.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})\b/);
  if (!us) return null;
  const year = Number(us[3]) < 100 ? 2_000 + Number(us[3]) : Number(us[3]);
  return validDate(year, Number(us[1]), Number(us[2]));
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function supportedText<T extends z.infer<typeof textField>>(value: T | null, raw: string,
  issue: ReceiptIssue, issues: ReceiptIssue[]): T | null {
  if (!value) return null;
  if (!raw.includes(normalize(value.evidence)) || !normalize(value.evidence).includes(normalize(value.value))) {
    addIssue(issues, issue); return null;
  }
  return value;
}

function supportedAmount<T extends z.infer<typeof amountField>>(value: T | null, raw: string,
  issue: ReceiptIssue, issues: ReceiptIssue[]): T | null {
  if (!value) return null;
  const evidence = normalize(value.evidence);
  if (!evidence || !raw.includes(evidence)) { addIssue(issues, issue); return null; }
  if (!evidenceHasCents(evidence, value.value_cents)) {
    addIssue(issues, "evidence_value_mismatch"); return null;
  }
  return value;
}

function evidenceHasCents(evidence: string, cents: number): boolean {
  const values = evidence.match(/-?\(?\$?\s*\d[\d,]*\.\d{2}\)?|-?\(?\$?\s*\.\d{2}\)?/g) ?? [];
  return values.some((value) => moneyToCents(value) === cents);
}

function sharesPrintedRow(rows: string[], descriptionEvidence: string, amountEvidence: string): boolean {
  return rows.some((row) => row.includes(descriptionEvidence) && row.includes(amountEvidence));
}

function moneyToCents(value: string): number | null {
  const negative = value.includes("-") || (value.includes("(") && value.includes(")"));
  const cleaned = value.replace(/[$,()\s-]/g, "");
  const match = cleaned.match(/^(\d*)\.(\d{2})$/);
  if (!match) return null;
  const cents = Number(match[1] || "0") * 100 + Number(match[2]);
  return negative ? -cents : cents;
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/\s+/g, " ").trim();
}

function addIssue(issues: ReceiptIssue[], issue: ReceiptIssue): void {
  if (!issues.includes(issue)) issues.push(issue);
}
