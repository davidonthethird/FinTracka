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
  const merchantObservation = visible
    .filter((item) => !dateFrom(item.text) && amountFrom(item.text, true) === null)
    .map((item) => ({ item, score: merchantScore(item) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score || left.item.relative_y - right.item.relative_y)[0]?.item;
  const dateObservation = visible.find((item) => dateFrom(item.text));
  const subtotal = labeledAmount(visible, ocrPrefixPattern(/^sub\s*total\b/i));
  const discount = labeledAmount(visible, ocrPrefixPattern(/^(?:discount|coupon|savings)\b/i));
  const tax = labeledAmount(visible, ocrPrefixPattern(/^(?:total\s+)?ta[ xk]\b/i));
  const tip = labeledAmount(visible, ocrPrefixPattern(/^(?:tip|gratuity)\b/i));
  const fees = labeledAmount(visible, ocrPrefixPattern(/^(?:service|delivery|convenience)\s+fee\b/i));
  const balance = [...visible].reverse().find((item) => /\bbalance\b/i.test(item.text)
    && amountFrom(item.text, true) !== null);
  const total = balance ?? [...visible].reverse().find((item) => isTotalLine(item.text)
    && amountFrom(item.text, true) !== null);
  const excluded = new Set([merchantObservation?.id, dateObservation?.id, subtotal?.id,
    discount?.id, tax?.id, tip?.id, fees?.id, total?.id]);
  const lines = visible.filter((item) => !excluded.has(item.id))
    .filter((item) => !isSummaryLine(item.text))
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
    ...(subtotal ? { subtotal_minor: field(subtotal, amountFrom(subtotal.text, true)!) } : {}),
    ...(discount ? { discount_minor: field(discount, amountFrom(discount.text, true)!) } : {}),
    ...(tax ? { tax_minor: field(tax, amountFrom(tax.text, true)!) } : {}),
    ...(tip ? { tip_minor: field(tip, amountFrom(tip.text, true)!) } : {}),
    ...(fees ? { fees_minor: field(fees, amountFrom(fees.text, true)!) } : {}),
    ...(total ? { total_minor: field(total, amountFrom(total.text, true)!) } : {}),
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
  return items.find((item) => pattern.test(item.text) && amountFrom(item.text, true) !== null);
}

function amountFrom(text: string, tolerant = false): number | null {
  let normalized = text.trim();
  if (tolerant) {
    normalized = normalized
      .replace(/(\d)\s*[¢©](?=\s|$)/g, (_match, digit: string) => `${digit}0`)
      .replace(/(\d)\s*[,;]\s*(\d{2})(?=\D|$)/g, "$1.$2");
    const matches = [...normalized.replace(/,/g, "")
      .matchAll(/(?:^|\s|\$)(-?\d{1,7}\.\d{2})(?=\s|$|\D)/g)];
    const amount = Number(matches.at(-1)?.[1]);
    return Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : null;
  }
  const match = normalized.replace(/,/g, "").match(/(?:^|\s|\$)(-?\d{1,7}\.\d{2})\s*$/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : null;
}

function merchantScore(item: LocatedObservation): number {
  const text = item.text.trim();
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  if (letters < 4 || text.length > 100 || isSummaryLine(text)
    || /\b(?:www\.|https?|receipt|cashier|register|terminal|thank\s+you)\b/i.test(text)) return -Infinity;
  const uppercase = text.match(/[A-Z]/g)?.length ?? 0;
  const merchantSignal = /\b(?:acme|cafe|centers?|coffee|depot|grocery|lowe'?s?|market|mart|pharmacy|restaurant|shop|store|target)\b/i.test(text)
    || /stop\W*e*\W*shop/i.test(text);
  return (merchantSignal ? 100 : 0)
    + (/\b(?:inc|llc|corp(?:oration)?)\b/i.test(text) ? 35 : 0)
    + (uppercase / letters >= 0.65 ? 10 : 0)
    + Math.max(0, 30 - Math.round(item.relative_y * 100));
}

function isTotalLine(text: string): boolean {
  return ocrPrefixPattern(/^(?:(?:grand|invoice)(?:\s+\d+)?\s+)?(?:total|balance)\b/i).test(text)
    && !ocrPrefixPattern(/^total\s+ta[ xk]\b/i).test(text);
}

function isSummaryLine(text: string): boolean {
  return /\bbalance\b/i.test(text)
    || ocrPrefixPattern(/^(?:sub\s*total|(?:grand|invoice)(?:\s+\d+)?\s+total|total|(?:total\s+)?ta[ xk]|tip|gratuity|discount|coupon|savings|sale\s+savings|service\s+fee|delivery\s+fee|convenience\s+fee|payment\s+amount|mastercard|visa|amex|discover|h\/c|change)\b/i).test(text);
}

function ocrPrefixPattern(pattern: RegExp): RegExp {
  return new RegExp(`^\\s*[^A-Za-z0-9$]*${pattern.source.replace(/^\^/, "")}`, pattern.flags);
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
