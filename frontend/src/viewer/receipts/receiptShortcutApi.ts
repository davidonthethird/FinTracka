import { MobileCommandApiError, mobileJson } from "../api";

export interface ReceiptScanSession {
  contract: "receipt_scan_session/v1";
  token: string;
  upload_url: string;
  expires_at: string;
}

export interface PublicReceiptImport {
  id: string;
  shortcut_version: 1;
  pages: { page_index: number; text: string }[];
  created_at: string;
  expires_at: string;
}

export async function createReceiptScanSession(): Promise<ReceiptScanSession> {
  return await mobileJson<ReceiptScanSession>("/api/v1/mobile/receipt-scan-sessions", {
    method: "POST", body: "{}",
  });
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

export function buildReceiptShortcutUrl(session: ReceiptScanSession): string {
  const query = new URLSearchParams({
    name: "FinTracka Scan Receipt",
    input: "text",
    text: JSON.stringify(session),
  });
  return `shortcuts://run-shortcut?${query.toString()}`;
}
