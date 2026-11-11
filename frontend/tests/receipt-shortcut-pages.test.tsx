import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildReceiptShortcutUrl,
  createReceiptScanSession,
  deleteReceiptImport,
  getReceiptQueueHandoff,
  getReceiptScanResult,
  getReceiptImport,
  listReceiptQueueHandoffs,
  retryReceiptImport,
  selectReceiptModelResult,
  watchReceiptScanSession,
  type PublicReceiptImport,
} from "../src/viewer/receipts/receiptShortcutApi";
import { ReceiptQueueHandoffView } from "../src/viewer/receipts/ReceiptInboxPage";
import { finalizeReceiptImport } from "../src/viewer/receipts/ReceiptShortcutImportPage";
import { receiptBenchmarkDiagnostic } from "../src/viewer/receipts/ReceiptBenchmarkSummary";

const session = {
  contract: "receipt_scan_session/v1" as const,
  shortcut_version: 2 as const,
  shortcut_name: "FinTracka Receipt Scanner" as const,
  token: "sensitive-one-time-token",
  upload_url: "https://viewer.example/api/v1/mobile/shortcut/receipt-imports",
  expires_at: "2026-11-02T12:30:00.000Z",
};

const queueSession = {
  contract: "receipt_queue_handoff/v1" as const,
  shortcut_version: 4 as const,
  comparison_enabled: true as const,
  shortcut_name: "FinTracka Receipt Scanner" as const,
  handoff_id: "00000000-0000-4000-8000-000000000004",
  expires_at: "2026-11-09T12:30:00.000Z",
};

describe("receipt Shortcut pages", () => {
  it("preloads a session in memory and creates a URL-encoded Shortcut handoff", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), {
      status: 201, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await createReceiptScanSession();
    const url = buildReceiptShortcutUrl(prepared);
    const parsed = new URL(url);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/mobile/receipt-scan-sessions", expect.objectContaining({
      method: "POST", credentials: "same-origin", body: "{}",
    }));
    expect(parsed.protocol).toBe("shortcuts:");
    expect(parsed.searchParams.get("name")).toBe("FinTracka Receipt Scanner");
    expect(url).toContain("name=FinTracka%20Receipt%20Scanner");
    expect(url).not.toContain("FinTracka+Scan+Receipt");
    expect(parsed.searchParams.get("input")).toBe("text");
    expect(JSON.parse(parsed.searchParams.get("text") ?? "")).toEqual(session);
    expect(url).not.toMatch(/^https?:/);
    vi.unstubAllGlobals();
  });

  it("launches version 4 with only the private queue contract and opaque handoff id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(queueSession), {
      status: 201, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await createReceiptScanSession();
    const parsed = new URL(buildReceiptShortcutUrl(prepared));

    expect(parsed.searchParams.get("text")).toBe(
      `receipt_queue_handoff/v1\n${queueSession.handoff_id}`,
    );
    expect(parsed.toString()).not.toMatch(/token|upload_url|https?%3A/i);
    vi.unstubAllGlobals();
  });

  it("rediscovers member-scoped queued handoffs after the page is recreated", async () => {
    const handoffs = [{ id: queueSession.handoff_id, status: "pending" as const,
      created_at: "2026-11-09T12:00:00.000Z", expires_at: queueSession.expires_at }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ handoffs }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listReceiptQueueHandoffs()).resolves.toEqual(handoffs);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/mobile/receipt-queue-handoffs",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    vi.unstubAllGlobals();
  });

  it("polls a version 4 handoff and navigates to its one ready review", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ handoff: {
        id: queueSession.handoff_id, status: "pending", created_at: "2026-11-09T12:00:00.000Z",
        expires_at: queueSession.expires_at,
      } }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ handoff: {
        id: queueSession.handoff_id, status: "ready", created_at: "2026-11-09T12:00:00.000Z",
        expires_at: queueSession.expires_at, review_path: "/receipts/import/import-v4",
      } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onReady = vi.fn();

    const stop = watchReceiptScanSession(queueSession, { onReady, onError: vi.fn() }, 1_500);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith("/receipts/import/import-v4");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/mobile/receipt-queue-handoffs/${queueSession.handoff_id}`,
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows durable handoff states and safe failed guidance in the existing inbox", () => {
    const html = renderToStaticMarkup(<ReceiptQueueHandoffView handoffs={[
      { id: "pending", status: "pending", created_at: "2026-11-09T12:00:00.000Z",
        expires_at: "2026-11-16T12:00:00.000Z" },
      { id: "processing", status: "processing", created_at: "2026-11-09T12:01:00.000Z",
        expires_at: "2026-11-16T12:01:00.000Z" },
      { id: "ready", status: "ready", created_at: "2026-11-09T12:02:00.000Z",
        expires_at: "2026-11-16T12:02:00.000Z", review_path: "/receipts/import/ready" },
      { id: "failed", status: "failed", created_at: "2026-11-09T12:03:00.000Z",
        expires_at: "2026-11-16T12:03:00.000Z", error_code: "INVALID_PACKAGE" },
    ]} onOpen={() => undefined} />);

    expect(html).toContain("Waiting for Mac");
    expect(html).toContain("Processing");
    expect(html).toContain("Ready to review");
    expect(html).toContain("Scan again or check the shared iCloud folder");
    expect(html).not.toContain("INVALID_PACKAGE");
  });

  it("gets, retries, and deletes only the opaque import URL", async () => {
    const imported = receiptImport("SYNTHETIC MARKET\nAPPLES 4.50\nTOTAL 4.50");
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => init?.method === "DELETE"
      ? new Response(null, { status: 204 }) : String(_path).endsWith("/retry")
        ? new Response(JSON.stringify({ status: "pending" }), { status: 200,
          headers: { "Content-Type": "application/json" } })
      : new Response(JSON.stringify({ import: imported }), { status: 200,
        headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getReceiptImport(imported.id)).resolves.toEqual(imported);
    await retryReceiptImport(imported.id);
    await deleteReceiptImport(imported.id);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/v1/mobile/receipt-imports/${imported.id}`,
      `/api/v1/mobile/receipt-imports/${imported.id}/retry`,
      `/api/v1/mobile/receipt-imports/${imported.id}`,
    ]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("sensitive-one-time-token");
    vi.unstubAllGlobals();
  });

  it("polls the private session and returns an internal review path when the scan is ready", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "ready", review_path: "/receipts/import/import-123",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onReady = vi.fn();

    const stop = watchReceiptScanSession(session.token, { onReady, onError: vi.fn() }, 1_500);
    await vi.advanceTimersByTimeAsync(0);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onReady).toHaveBeenCalledWith("/receipts/import/import-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/mobile/receipt-scan-sessions/result",
      expect.objectContaining({ method: "POST", credentials: "same-origin",
        body: JSON.stringify({ token: session.token }) }),
    );
    expect(fetchMock.mock.calls.every(([path]) => !String(path).includes(session.token))).toBe(true);
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps polling after Safari interrupts one request while returning from Shortcuts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }))
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "ready", review_path: "/receipts/import/import-after-resume",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onReady = vi.fn();
    const onError = vi.fn();

    const stop = watchReceiptScanSession(session.token, { onReady, onError }, 1_500);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(onReady).toHaveBeenCalledWith("/receipts/import/import-after-resume");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns pending and ready scan results from the authenticated browser endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "pending" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getReceiptScanResult(session.token)).resolves.toEqual({ status: "pending" });
    vi.unstubAllGlobals();
  });

  it("creates idempotently before cleanup and returns the populated draft", async () => {
    const events: string[] = [];
    const imported = receiptImport("SYNTHETIC MARKET\nAPPLES 4.50\nTOTAL 4.50");
    const persisted = { id: "draft-1" } as never;

    const result = await finalizeReceiptImport(imported, {
      create: async (draft, key) => { events.push(`create:${key}:${draft.total_minor}`); return persisted; },
      cleanup: async () => { events.push("cleanup"); },
    });

    expect(result).toEqual({ status: "created", draft: persisted });
    expect(events).toEqual([`create:shortcut-import-${imported.id}:450`, "cleanup"]);
  });

  it("never creates a v3 draft before the member selects a model result", async () => {
    const imported: PublicReceiptImport = {
      ...receiptImport("Synthetic Market\nITEM 10.00\nTOTAL 10.00"),
      shortcut_version: 3,
      selection: null,
      comparison: { recommendation: "tie", material_disagreement: false, runs: [] },
      validation: null,
    };
    const create = vi.fn();
    const result = await finalizeReceiptImport(imported, { create, cleanup: vi.fn() });
    expect(result).toEqual({ status: "comparing", imported });
    expect(create).not.toHaveBeenCalled();
  });

  it("posts an explicit member selection to the opaque import endpoint", async () => {
    const imported = { ...receiptImport("private text"), shortcut_version: 3 as const,
      selection: "on_device" as const };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ import: imported }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(selectReceiptModelResult(imported.id, "on_device")).resolves.toEqual(imported);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/mobile/receipt-imports/${imported.id}/selection`,
      expect.objectContaining({ method: "POST", credentials: "same-origin",
        body: JSON.stringify({ selection: "on_device" }) }),
    );
    vi.unstubAllGlobals();
  });

  it("still returns the created draft when temporary-import cleanup fails", async () => {
    const imported = receiptImport("SYNTHETIC MARKET\nAPPLES 4.50\nTOTAL 4.50");
    const persisted = { id: "draft-1" } as never;
    const result = await finalizeReceiptImport(imported, {
      create: async () => persisted,
      cleanup: async () => { throw new Error("network"); },
    });

    expect(result).toEqual({ status: "created", draft: persisted });
  });

  it("keeps unusable recognized text reviewable without creating a draft", async () => {
    const imported = receiptImport("###\n---");
    const create = vi.fn();
    const cleanup = vi.fn();

    const result = await finalizeReceiptImport(imported, { create, cleanup });

    expect(result).toEqual({ status: "unusable", imported });
    expect(create).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("does not create a draft after import finalization is cancelled", async () => {
    const imported = receiptImport("SYNTHETIC MARKET\nAPPLES 4.50\nTOTAL 4.50");
    const create = vi.fn();
    const cleanup = vi.fn();

    const result = await finalizeReceiptImport(imported, { create, cleanup, cancelled: () => true });

    expect(result).toEqual({ status: "cancelled" });
    expect(create).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("waits for a pending refinement instead of creating an empty draft", async () => {
    const imported: PublicReceiptImport = { ...receiptImport("###"), shortcut_version: 2,
      validation: { status: "needs_refinement", issues: ["invalid_model_result"], receipt: null },
      refinement: { id: "refinement-1", status: "pending", error_code: null } };
    const create = vi.fn();
    const result = await finalizeReceiptImport(imported, { create, cleanup: vi.fn() });
    expect(result).toEqual({ status: "refining", imported });
    expect(create).not.toHaveBeenCalled();
  });

  it("never falls back to the legacy parser after Mac refinement fails", async () => {
    const imported: PublicReceiptImport = { ...receiptImport("SYNTHETIC MARKET\nTOTAL 4.50"),
      shortcut_version: 2,
      validation: { status: "needs_refinement", issues: ["invalid_model_result"], receipt: null },
      refinement: { id: "refinement-1", status: "failed", error_code: "MODEL_UNAVAILABLE" } };
    const create = vi.fn();
    const result = await finalizeReceiptImport(imported, { create, cleanup: vi.fn() });
    expect(result).toEqual({ status: "failed", imported });
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed when a v2 response has no validation payload", async () => {
    const imported: PublicReceiptImport = { ...receiptImport("SYNTHETIC MARKET\nAPPLES 4.50\nTOTAL 4.50"),
      shortcut_version: 2, validation: null, refinement: null };
    const create = vi.fn();
    const result = await finalizeReceiptImport(imported, { create, cleanup: vi.fn() });
    expect(result).toEqual({ status: "unusable", imported });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates directly from evidence-validated model fields without reparsing OCR text", async () => {
    const imported: PublicReceiptImport = { ...receiptImport("garbled text that the legacy parser cannot use"),
      shortcut_version: 2, validation: { status: "accepted", issues: [], receipt: {
        merchant: { value: "Synthetic Market", evidence: "SYNTHETIC MARKET" },
        date: { value: "2026-11-04", evidence: "11/04/2026" },
        subtotal: { value_cents: 450, evidence: "SUBTOTAL 4.50" }, discounts: [],
        tax: { value_cents: 36, evidence: "TAX 0.36" }, tip: null, fees: [],
        total: { value_cents: 486, evidence: "TOTAL 4.86" }, lines: [{ description: "APPLES",
          amount_cents: 450, description_evidence: "APPLES", amount_evidence: "4.50" }],
      } }, refinement: null };
    const create = vi.fn(async () => ({ id: "draft-v2" }) as never);

    const result = await finalizeReceiptImport(imported, { create, cleanup: vi.fn() });

    expect(result.status).toBe("created");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ merchant: "Synthetic Market",
      purchase_date: "2026-11-04", subtotal_minor: 450, tax_minor: 36, total_minor: 486,
      source_text: expect.stringContaining("garbled text"),
      lines: [expect.objectContaining({ description: "APPLES", item_total_minor: 450 })] }),
    `shortcut-import-${imported.id}`);
  });

  it("builds a metadata-only diagnostic report without financial or identity fields", () => {
    const report = receiptBenchmarkDiagnostic({
      total: 2,
      selections: { on_device: 1, private_cloud_compute: 1, tie: 0, neither: 0, unselected: 0 },
      on_device: { completed: 2, accepted: 1, needs_review: 1, needs_refinement: 0,
        unavailable: 0, median_duration_ms: 200 },
      private_cloud_compute: { completed: 2, accepted: 2, needs_review: 0, needs_refinement: 0,
        unavailable: 0, median_duration_ms: 900 },
    });

    expect(report).toContain("receipt_model_benchmark_diagnostic/v1");
    expect(report).not.toMatch(/merchant|amount|description|account|transaction|token|ocr|model_result/i);
  });
});

function receiptImport(text: string): PublicReceiptImport {
  return { id: "00000000-0000-4000-8000-000000000001", shortcut_version: 1,
    pages: [{ page_index: 0, text }], created_at: "2026-11-02T12:00:00.000Z",
    expires_at: "2026-11-02T12:30:00.000Z" };
}
