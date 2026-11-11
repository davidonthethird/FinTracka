import { MobileCommandApiError, mobileJson } from "../api";

export interface LegacyReceiptScanSession {
  contract: "receipt_scan_session/v1";
  shortcut_version: 2 | 3;
  comparison_enabled?: boolean;
  shortcut_name: "FinTracka Receipt Scanner";
  token: string;
  upload_url: string;
  expires_at: string;
}

export interface QueueReceiptScanSession {
  contract: "receipt_queue_handoff/v1";
  shortcut_version: 4;
  comparison_enabled: true;
  shortcut_name: "FinTracka Receipt Scanner";
  handoff_id: string;
  expires_at: string;
}

export type ReceiptScanSession = LegacyReceiptScanSession | QueueReceiptScanSession;

export type ReceiptScanResult =
  | { status: "pending" }
  | { status: "ready"; review_path: string };

export interface ReceiptQueueHandoff {
  id: string;
  status: "pending" | "processing" | "ready" | "failed";
  created_at: string;
  expires_at: string;
  review_path?: string;
  error_code?: string;
}

export interface PublicReceiptImport {
  id: string;
  shortcut_version: 1 | 2 | 3;
  pages: { page_index: number; text: string }[];
  validation?: ReceiptValidation | null;
  comparison?: ReceiptModelComparison | null;
  selection?: ReceiptModelSelection | null;
  refinement?: { id: string; status: "pending" | "claimed" | "completed" | "failed";
    error_code: string | null } | null;
  created_at: string;
  expires_at: string;
}

export type ReceiptModelRoute = "on_device" | "private_cloud_compute";
export type ReceiptModelSelection = ReceiptModelRoute | "tie" | "neither";

export interface ReceiptModelRun {
  model: ReceiptModelRoute;
  status: "completed" | "unavailable" | "rate_limited" | "failed";
  duration_ms: number;
  error_code?: string;
  validation: ReceiptValidation | null;
}

export interface ReceiptModelComparison {
  runs: ReceiptModelRun[];
  recommendation: ReceiptModelSelection;
  material_disagreement: boolean;
}

export interface ReceiptBenchmarkSummary {
  total: number;
  selections: Record<ReceiptModelSelection | "unselected", number>;
  on_device: ReceiptRouteSummary;
  private_cloud_compute: ReceiptRouteSummary;
}

export interface ReceiptRouteSummary {
  completed: number;
  accepted: number;
  needs_review: number;
  needs_refinement: number;
  unavailable: number;
  median_duration_ms: number | null;
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

export async function listReceiptQueueHandoffs(): Promise<ReceiptQueueHandoff[]> {
  return (await mobileJson<{ handoffs: ReceiptQueueHandoff[] }>(
    "/api/v1/mobile/receipt-queue-handoffs",
  )).handoffs;
}

export async function getReceiptQueueHandoff(id: string): Promise<ReceiptQueueHandoff> {
  return (await mobileJson<{ handoff: ReceiptQueueHandoff }>(
    `/api/v1/mobile/receipt-queue-handoffs/${encodeURIComponent(id)}`,
  )).handoff;
}

export function watchReceiptScanSession(
  session: ReceiptScanSession | string,
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
      const result = typeof session === "string"
        ? await getReceiptScanResult(session)
        : session.shortcut_version === 4
          ? await getReceiptQueueHandoff(session.handoff_id)
          : await getReceiptScanResult(session.token);
      if (!active) return;
      if (result.status === "ready" && result.review_path) {
        active = false;
        callbacks.onReady(result.review_path);
        return;
      }
    } catch (error) {
      if (active && !(error instanceof TypeError)) {
        active = false;
        callbacks.onError(error);
        return;
      }
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

export async function selectReceiptModelResult(
  id: string,
  selection: ReceiptModelSelection,
): Promise<PublicReceiptImport> {
  return (await mobileJson<{ import: PublicReceiptImport }>(
    `/api/v1/mobile/receipt-imports/${encodeURIComponent(id)}/selection`,
    { method: "POST", body: JSON.stringify({ selection }) },
  )).import;
}

export async function getReceiptBenchmarkSummary(): Promise<ReceiptBenchmarkSummary> {
  return (await mobileJson<{ summary: ReceiptBenchmarkSummary }>(
    "/api/v1/mobile/receipt-model-benchmarks/summary",
  )).summary;
}

export async function deleteReceiptBenchmarkHistory(): Promise<void> {
  const response = await fetch("/api/v1/mobile/receipt-model-benchmarks/summary", {
    method: "DELETE", cache: "no-store", credentials: "same-origin",
  });
  if (!response.ok) throw new MobileCommandApiError(response.status,
    "RECEIPT_BENCHMARK_DELETE_FAILED", "Benchmark history could not be removed.");
}

export function buildReceiptShortcutUrl(session: ReceiptScanSession): string {
  const text = session.shortcut_version === 4
    ? `${session.contract}\n${session.handoff_id}`
    : JSON.stringify(session);
  const query = [
    `name=${encodeURIComponent(session.shortcut_name)}`,
    "input=text",
    `text=${encodeURIComponent(text)}`,
  ].join("&");
  return `shortcuts://run-shortcut?${query}`;
}
