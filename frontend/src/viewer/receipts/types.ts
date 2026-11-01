export type SpendingOwner = "David" | "Ariela" | "Shared";

export interface AllocationBasis {
  id: string;
  basis_minor: number;
}

export interface AllocationResult {
  id: string;
  amount_minor: number;
}

export interface ReceiptReconciliationLineInput {
  id: string;
  item_total_minor: number;
  line_discount_minor: number;
  taxable: boolean;
}

export interface ReceiptReconciliationInput {
  lines: ReceiptReconciliationLineInput[];
  receipt_discount_minor: number;
  tax_minor: number;
  tip_minor: number;
  fees_minor: number;
  total_minor: number;
}

export interface ReceiptReconciliationLineResult {
  id: string;
  receipt_discount_minor: number;
  tax_minor: number;
  tip_minor: number;
  fees_minor: number;
  final_minor: number;
}

export interface ReceiptReconciliation {
  lines: ReceiptReconciliationLineResult[];
  calculated_total_minor: number;
  difference_minor: number;
}

export type ReceiptImageSource = string | Blob | File | HTMLCanvasElement | OffscreenCanvas;

export interface PreparedReceiptPage {
  id: string;
  image: ReceiptImageSource;
}

export interface OcrReceiptPage {
  id: string;
  page_index: number;
  text: string;
  confidence_basis_points: number;
}

export interface ReceiptOcrProgress {
  page_index: number;
  page_count: number;
  status: string;
  progress_basis_points: number;
}

export interface ReceiptOcrEngine {
  recognize(pages: PreparedReceiptPage[], signal: AbortSignal): Promise<OcrReceiptPage[]>;
  terminate(): Promise<void>;
}
