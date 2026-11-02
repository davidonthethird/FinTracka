import type { OcrObservation, OcrReceiptPage } from "./types";

export interface ShortcutTextPage {
  page_index: number;
  text: string;
}

const CONFIDENCE_BASIS_POINTS = 7_000;
const ROW_TOP = 40;
const ROW_GAP = 70;
const ROW_HEIGHT = 40;

export function receiptPagesFromPlainText(pages: ShortcutTextPage[]): OcrReceiptPage[] {
  return [...pages].sort((left, right) => left.page_index - right.page_index).map((page) => {
    const lines = normalizedLines(page.text);
    const rowIndexes = syntheticRows(lines);
    const rowCount = Math.max(1, ...rowIndexes.map((row) => row + 1));
    const observations = lines.map((text, index): OcrObservation => {
      const row = rowIndexes[index];
      const amount = moneyOnly(text);
      return {
        id: `shortcut-${page.page_index}-${index}`,
        text,
        confidence_basis_points: CONFIDENCE_BASIS_POINTS,
        bbox: amount
          ? { x: 1_300, y: ROW_TOP + row * ROW_GAP, width: 220, height: ROW_HEIGHT }
          : { x: 100, y: ROW_TOP + row * ROW_GAP, width: 1_050, height: ROW_HEIGHT },
        relative_y: rowCount === 1 ? 0.5 : row / (rowCount - 1),
      };
    });
    return {
      id: `shortcut-page-${page.page_index}`,
      page_index: page.page_index,
      text: lines.join("\n"),
      confidence_basis_points: CONFIDENCE_BASIS_POINTS,
      observations,
    };
  });
}

function normalizedLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
}

function syntheticRows(lines: string[]): number[] {
  const rows: number[] = [];
  let row = 0;
  for (let index = 0; index < lines.length; index += 1) {
    rows.push(row);
    if (!moneyOnly(lines[index]) && moneyOnly(lines[index + 1] ?? "")) {
      rows.push(row);
      index += 1;
    }
    row += 1;
  }
  return rows;
}

function moneyOnly(text: string): boolean {
  return /^\s*(?:[@x]\s*)?\$?-?\d[\d,]*\.\d{2}(?:\s*[A-Z-]{0,2})?\s*$/i.test(text);
}
