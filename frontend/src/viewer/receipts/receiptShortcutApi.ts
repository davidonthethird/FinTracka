import { MobileCommandApiError, mobileJson } from "../api";

export interface ReceiptScanSession {
  contract: "receipt_scan_session/v1";
  shortcut_version: 2 | 3;
  comparison_enabled?: boolean;
  shortcut_name: "FinTracka Receipt Scanner";
  token: string;
  handoff_contract: "fintracka_receipt_handoff/v1";
  expires_at: string;
}

interface ReceiptClipboard {
  readText(): Promise<string>;
  writeText(value: string): Promise<void>;
}

export type ReceiptScanResult =
  | { status: "pending" }
  | { status: "ready"; review_path: string };

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

export async function completeReceiptScanFromClipboard(
  session: ReceiptScanSession,
  clipboard: ReceiptClipboard = navigator.clipboard,
): Promise<string> {
  let raw: string;
  try {
    raw = await clipboard.readText();
  } catch {
    throw new Error("Allow clipboard access so FinTracka can import the recognized receipt text.");
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("The clipboard does not contain FinTracka receipt scan results."); }
  const handoff = parseReceiptHandoff(value);
  if (!handoff) {
    throw new Error("The clipboard does not contain FinTracka receipt scan results.");
  }
  if (handoff.token !== session.token) {
    throw new Error("These receipt results belong to a different or expired current scan.");
  }
  const result = await mobileJson<{ review_path: string }>(
    "/api/v1/mobile/receipt-scan-sessions/complete",
    { method: "POST", body: JSON.stringify(handoff) },
  );
  try { await clipboard.writeText(""); } catch { /* successful import is already single-use */ }
  return result.review_path;
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
  const query = [
    `name=${encodeURIComponent(session.shortcut_name)}`,
    "input=text",
    `text=${encodeURIComponent(JSON.stringify(session))}`,
  ].join("&");
  return `shortcuts://run-shortcut?${query}`;
}

function parseReceiptHandoff(value: unknown): {
  contract: "fintracka_receipt_handoff/v1"; token: string; capture: Record<string, unknown>;
} | null {
  if (!isRecord(value) || value.contract !== "fintracka_receipt_handoff/v1"
    || typeof value.token !== "string" || !isRecord(value.capture)) return null;
  const capture = value.capture;
  if (capture.contract !== "receipt_shortcut_capture/v3"
    || typeof capture.idempotency_key !== "string"
    || !/^[a-f0-9]{64}$/i.test(capture.idempotency_key)
    || capture.shortcut_version !== 3
    || typeof capture.text_base64 !== "string"
    || !Array.isArray(capture.runs)) return null;
  const text = decodeBase64Text(capture.text_base64);
  if (text === null) return null;
  const runs = capture.runs.map((run) => {
    if (!isRecord(run)
      || (run.model !== "on_device" && run.model !== "private_cloud_compute")
      || run.status !== "completed"
      || typeof run.duration_ms !== "number" || !Number.isFinite(run.duration_ms)
      || run.duration_ms < 0
      || typeof run.model_result_base64 !== "string") return null;
    const modelResult = decodeBase64Text(run.model_result_base64);
    return modelResult === null ? null : {
      model: run.model, status: run.status, duration_ms: run.duration_ms,
      model_result: modelResult,
    };
  });
  if (runs.some((run) => run === null)) return null;
  return {
    contract: "fintracka_receipt_handoff/v1",
    token: value.token,
    capture: {
      contract: capture.contract,
      idempotency_key: capture.idempotency_key,
      shortcut_version: capture.shortcut_version,
      text,
      runs,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64Text(value: string): string | null {
  const compact = value.replace(/\s/g, "");
  if (!compact || compact.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) return null;
  try {
    const bytes = Uint8Array.from(atob(compact), (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return null; }
}
