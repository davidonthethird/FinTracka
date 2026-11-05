import { MobileCommandApiError, mobileJson } from "../api";

export interface ReceiptScanSession {
  contract: "receipt_scan_session/v1";
  shortcut_version: 2;
  shortcut_name: "FinTracka Receipt Scanner";
  token: string;
  upload_url: string;
  expires_at: string;
}

export type ReceiptScanResult =
  | { status: "pending" }
  | { status: "ready"; review_path: string };

export interface PublicReceiptImport {
  id: string;
  shortcut_version: 1 | 2;
  pages: { page_index: number; text: string }[];
  validation?: ReceiptValidation | null;
  refinement?: { id: string; status: "pending" | "claimed" | "completed" | "failed";
    error_code: string | null } | null;
  created_at: string;
  expires_at: string;
}

export interface ReceiptValidation {
  status: "accepted" | "needs_review" | "needs_refinement";
  issues: string[];
  receipt: ValidatedReceipt | null;
}

export interface ValidatedReceipt {
  merchant: { value: string; evidence: string } | null;
  date: { value: string; evidence: string } | null;
  subtotal: { value_cents: number; evidence: string } | null;
  discounts: { value_cents: number; evidence: string }[];
  tax: { value_cents: number; evidence: string } | null;
  tip: { value_cents: number; evidence: string } | null;
  fees: { value_cents: number; evidence: string }[];
  total: { value_cents: number; evidence: string } | null;
  lines: { description: string; amount_cents: number; description_evidence: string;
    amount_evidence: string }[];
}

export async function createReceiptScanSession(): Promise<ReceiptScanSession> {
  return await mobileJson<ReceiptScanSession>("/api/v1/mobile/receipt-scan-sessions", {
    method: "POST", body: "{}",
  });
}

export async function getReceiptScanResult(token: string): Promise<ReceiptScanResult> {
  return await mobileJson<ReceiptScanResult>("/api/v1/mobile/receipt-scan-sessions/result", {
    method: "POST", body: JSON.stringify({ token }),
  });
}

export function watchReceiptScanSession(
  token: string,
  callbacks: { onReady: (path: string) => void; onError: (error: unknown) => void },
  intervalMs = 1_500,
): () => void {
  let active = true;
  let checking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = async () => {
    if (!active || checking) return;
    checking = true;
    try {
      const result = await getReceiptScanResult(token);
      if (!active) return;
      if (result.status === "ready") {
        active = false;
        callbacks.onReady(result.review_path);
        return;
      }
    } catch (error) {
      if (active) {
        active = false;
        callbacks.onError(error);
      }
      return;
    } finally {
      checking = false;
    }
    if (active) timer = setTimeout(check, intervalMs);
  };
  const resume = () => {
    if (typeof document === "undefined" || document.visibilityState === "visible") void check();
  };

  if (typeof window !== "undefined") window.addEventListener("focus", resume);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", resume);
  void check();
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
    if (typeof window !== "undefined") window.removeEventListener("focus", resume);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resume);
  };
}

export async function getReceiptImport(id: string): Promise<PublicReceiptImport> {
  return (await mobileJson<{ import: PublicReceiptImport }>(
    `/api/v1/mobile/receipt-imports/${encodeURIComponent(id)}`,
  )).import;
}

export async function deleteReceiptImport(id: string): Promise<void> {
  const response = await fetch(`/api/v1/mobile/receipt-imports/${encodeURIComponent(id)}`, {
    method: "DELETE", cache: "no-store", credentials: "same-origin",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error_code?: string };
    throw new MobileCommandApiError(response.status, body.error_code ?? "RECEIPT_IMPORT_DELETE_FAILED",
      "The temporary receipt text could not be removed.");
  }
}

export async function retryReceiptImport(id: string): Promise<void> {
  await mobileJson(`/api/v1/mobile/receipt-imports/${encodeURIComponent(id)}/retry`, {
    method: "POST", body: JSON.stringify({}),
  });
}

export function buildReceiptShortcutUrl(session: ReceiptScanSession): string {
  const query = [
    `name=${encodeURIComponent(session.shortcut_name)}`,
    "input=text",
    `text=${encodeURIComponent(JSON.stringify(session))}`,
  ].join("&");
  return `shortcuts://run-shortcut?${query}`;
}
