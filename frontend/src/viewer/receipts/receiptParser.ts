import type { OcrObservation, OcrReceiptPage } from "./types";

export interface ParsedField<T> { value: T; observation_id: string; confidence_basis_points: number }
export interface ParsedReceiptLine {
  id: string;
  observation_id: string;
  description: string;
  item_total_minor: number;
  confidence_basis_points: number;
  page_index: number;
}
export interface ParsedReceiptCandidate {
  merchant?: ParsedField<string>;
  purchase_date?: ParsedField<string>;
  subtotal_minor?: ParsedField<number>;
  discount_minor?: ParsedField<number>;
  tax_minor?: ParsedField<number>;
  tip_minor?: ParsedField<number>;
  fees_minor?: ParsedField<number>;
  total_minor?: ParsedField<number>;
  lines: ParsedReceiptLine[];
  overlap_groups: { id: string; observation_ids: string[] }[];
  collapsed_observation_ids: string[];
}

interface LocatedObservation extends OcrObservation { page_index: number }

export function parseReceiptPages(pages: OcrReceiptPage[]): ParsedReceiptCandidate {
  const observations = pages.flatMap((page) => observationsForPage(page));
  const collapsed = new Set<string>();
  const overlapGroups: ParsedReceiptCandidate["overlap_groups"] = [];
  for (let pageIndex = 0; pageIndex < pages.length - 1; pageIndex += 1) {
    const left = observations.filter((item) => item.page_index === pageIndex && item.relative_y >= 0.85);
    const right = observations.filter((item) => item.page_index === pageIndex + 1 && item.relative_y <= 0.15);
    for (const first of left) for (const second of right) {
      const firstMoney = amountFrom(first.text); const secondMoney = amountFrom(second.text);
      if (firstMoney === null || firstMoney !== secondMoney) continue;
      if (normalize(first.text) === normalize(second.text)) {
        collapsed.add(second.id);
      } else if (editDistance(normalize(first.text), normalize(second.text)) <= 2) {
        overlapGroups.push({ id: `overlap-${overlapGroups.length + 1}`, observation_ids: [first.id, second.id] });
      }
    }
  }
  const visible = observations.filter((item) => !collapsed.has(item.id));
  const merchantObservation = visible.find((item) => !dateFrom(item.text) && amountFrom(item.text) === null);
  const dateObservation = visible.find((item) => dateFrom(item.text));
  const subtotal = labeledAmount(visible, /^\s*sub\s*total\b/i);
  const discount = labeledAmount(visible, /^\s*(?:discount|coupon|savings)\b/i);
  const tax = labeledAmount(visible, /^\s*tax\b/i);
  const tip = labeledAmount(visible, /^\s*(?:tip|gratuity)\b/i);
  const fees = labeledAmount(visible, /^\s*(?:service|delivery|convenience)\s+fee\b/i);
  const total = [...visible].reverse().find((item) => /^\s*(?:grand\s+)?total\b/i.test(item.text));
  const excluded = new Set([merchantObservation?.id, dateObservation?.id, subtotal?.id,
    discount?.id, tax?.id, tip?.id, fees?.id, total?.id]);
  const lines = visible.filter((item) => !excluded.has(item.id))
    .filter((item) => amountFrom(item.text) !== null)
    .map((item, index) => ({
      id: `parsed-${item.page_index}-${index}`,
      observation_id: item.id,
      description: descriptionFrom(item.text),
      item_total_minor: amountFrom(item.text)!,
      confidence_basis_points: item.confidence_basis_points,
      page_index: item.page_index,
    }));
  return {
    ...(merchantObservation ? { merchant: field(merchantObservation, merchantObservation.text.trim()) } : {}),
    ...(dateObservation ? { purchase_date: field(dateObservation, dateFrom(dateObservation.text)!) } : {}),
    ...(subtotal ? { subtotal_minor: field(subtotal, amountFrom(subtotal.text)!) } : {}),
    ...(discount ? { discount_minor: field(discount, amountFrom(discount.text)!) } : {}),
    ...(tax ? { tax_minor: field(tax, amountFrom(tax.text)!) } : {}),
    ...(tip ? { tip_minor: field(tip, amountFrom(tip.text)!) } : {}),
    ...(fees ? { fees_minor: field(fees, amountFrom(fees.text)!) } : {}),
    ...(total ? { total_minor: field(total, amountFrom(total.text)!) } : {}),
    lines,
    overlap_groups: overlapGroups,
    collapsed_observation_ids: [...collapsed],
  };
}

function observationsForPage(page: OcrReceiptPage): LocatedObservation[] {
  if (page.observations) return page.observations.map((item) => ({ ...item, page_index: page.page_index }));
  const lines = page.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((text, index) => ({ id: `${page.id}-${index}`, text,
    confidence_basis_points: page.confidence_basis_points,
    bbox: { x: 0, y: index, width: 0, height: 0 },
    relative_y: lines.length <= 1 ? 0.5 : index / (lines.length - 1), page_index: page.page_index }));
}

function field<T>(observation: LocatedObservation, value: T): ParsedField<T> {
  return { value, observation_id: observation.id, confidence_basis_points: observation.confidence_basis_points };
}

function labeledAmount(items: LocatedObservation[], pattern: RegExp) {
  return items.find((item) => pattern.test(item.text) && amountFrom(item.text) !== null);
}

function amountFrom(text: string): number | null {
  const match = text.replace(/,/g, "").match(/(?:^|\s|\$)(-?\d{1,7}\.\d{2})\s*$/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : null;
}

function descriptionFrom(text: string): string {
  return text.replace(/\s+\$?-?\d[\d,]*\.\d{2}\s*$/, "").trim();
}

function dateFrom(text: string): string | null {
  const match = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/);
  if (!match) return null;
  const year = match[3].length === 2 ? 2_000 + Number(match[3]) : Number(match[3]);
  const month = Number(match[1]); const day = Number(match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function normalize(text: string): string { return text.toUpperCase().replace(/[^A-Z0-9.]/g, ""); }

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let previous = row[0]; row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const current = row[rightIndex];
      row[rightIndex] = Math.min(row[rightIndex] + 1, row[rightIndex - 1] + 1,
        previous + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[right.length];
}
