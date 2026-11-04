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
  observations?: OcrObservation[];
}

export interface OcrObservation {
  id: string;
  text: string;
  confidence_basis_points: number;
  bbox: { x: number; y: number; width: number; height: number };
  relative_y: number;
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

export type ReceiptStatus = "editing" | "waiting_for_bank" | "match_pending" | "processing" | "matched" | "conflict" | "dismissed";

export interface ReceiptLineV1 {
  id: string;
  order: number;
  source_page: number | null;
  description: string;
  quantity: string;
  unit_amount_minor: number | null;
  item_total_minor: number;
  line_discount_minor: number;
  tax_minor: number;
  tip_minor: number;
  fees_minor: number;
  taxable: boolean;
  owner: SpendingOwner;
  category_id: string | null;
  subcategory_id: string | null;
  confidence_basis_points: number;
  review_flags: string[];
}

export interface ReceiptDraftV1 {
  contract: "receipt_draft/v1";
  status: ReceiptStatus;
  merchant: string;
  purchase_date: string | null;
  currency: string;
  masked_payment_hint: string | null;
  page_count: number;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  tip_minor: number;
  fees_minor: number;
  total_minor: number;
  review_flags?: string[];
  source_text?: string | null;
  lines: ReceiptLineV1[];
}

export interface ReceiptDraft extends ReceiptDraftV1 {
  id: string;
  revision: number;
  digest: string;
  created_at: string;
  updated_at: string;
  retention_at: string;
}
