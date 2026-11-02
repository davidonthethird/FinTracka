import { describe, expect, it, vi } from "vitest";

import {
  buildReceiptShortcutUrl,
  createReceiptScanSession,
  deleteReceiptImport,
  getReceiptImport,
  type PublicReceiptImport,
} from "../src/viewer/receipts/receiptShortcutApi";
import { finalizeReceiptImport } from "../src/viewer/receipts/ReceiptShortcutImportPage";

const session = {
  contract: "receipt_scan_session/v1" as const,
  token: "sensitive-one-time-token",
  upload_url: "https://viewer.example/api/v1/mobile/shortcut/receipt-imports",
  expires_at: "2026-11-02T12:10:00.000Z",
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
    expect(parsed.searchParams.get("name")).toBe("FinTracka Scan Receipt");
    expect(parsed.searchParams.get("input")).toBe("text");
    expect(JSON.parse(parsed.searchParams.get("text") ?? "")).toEqual(session);
    expect(url).not.toMatch(/^https?:/);
    vi.unstubAllGlobals();
  });

  it("gets and deletes only the opaque import URL", async () => {
    const imported = receiptImport("SYNTHETIC MARKET\nAPPLES 4.50\nTOTAL 4.50");
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ import: imported }), { status: 200,
        headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getReceiptImport(imported.id)).resolves.toEqual(imported);
    await deleteReceiptImport(imported.id);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/v1/mobile/receipt-imports/${imported.id}`,
      `/api/v1/mobile/receipt-imports/${imported.id}`,
    ]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("sensitive-one-time-token");
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
});

function receiptImport(text: string): PublicReceiptImport {
  return { id: "00000000-0000-4000-8000-000000000001", shortcut_version: 1,
    pages: [{ page_index: 0, text }], created_at: "2026-11-02T12:00:00.000Z",
    expires_at: "2026-11-02T12:30:00.000Z" };
}
