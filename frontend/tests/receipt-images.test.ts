import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareReceiptPage, ReceiptImageStore, ReceiptImageStoreError } from "../src/viewer/receipts/receiptImages";

const heic = vi.hoisted(() => ({
  heicTo: vi.fn(async () => new Blob(["jpeg"], { type: "image/jpeg" })),
}));

vi.mock("heic-to/csp", () => heic);

afterEach(() => vi.unstubAllGlobals());

describe("receipt image store", () => {
  it("stores ordered origin-private blobs with crop and rotation metadata", async () => {
    const store = new ReceiptImageStore(`receipt-test-${crypto.randomUUID()}`, new IDBFactory());
    await store.put("opaque-draft", "opaque-page-2", new Blob(["second"]), {
      order: 1, rotation_degrees: 90, crop: { x: 1, y: 2, width: 30, height: 40 },
    });
    await store.put("opaque-draft", "opaque-page-1", new Blob(["first"]), {
      order: 0, rotation_degrees: 0, crop: null,
    });
    const pages = await store.list("opaque-draft");
    expect(pages.map((page) => page.page_id)).toEqual(["opaque-page-1", "opaque-page-2"]);
    expect(await pages[0].blob.text()).toBe("first");
    expect(pages[1]).toMatchObject({ rotation_degrees: 90, crop: { width: 30 } });
    await store.deleteDraft("opaque-draft");
    expect(await store.list("opaque-draft")).toEqual([]);
  });

  it("prunes only stale page blobs and keeps structured receipt data outside this store", async () => {
    let now = new Date("2026-11-01T12:00:00Z");
    const store = new ReceiptImageStore(`receipt-test-${crypto.randomUUID()}`, new IDBFactory(), () => now);
    await store.put("old", "p1", new Blob(["old"]), { order: 0, rotation_degrees: 0, crop: null });
    now = new Date("2026-12-02T12:00:00Z");
    await store.put("new", "p1", new Blob(["new"]), { order: 0, rotation_degrees: 0, crop: null });
    expect(await store.prune(30)).toBe(1);
    expect(await store.list("old")).toEqual([]);
    expect(await store.list("new")).toHaveLength(1);
  });

  it("returns a typed recoverable quota state", async () => {
    const failing = { open() { throw new DOMException("full", "QuotaExceededError"); } } as unknown as IDBFactory;
    const store = new ReceiptImageStore("receipt-full", failing);
    await expect(store.put("d", "p", new Blob(["x"]), {
      order: 0, rotation_degrees: 0, crop: null,
    })).rejects.toEqual(expect.objectContaining<Partial<ReceiptImageStoreError>>({ code: "quota_exceeded" }));
  });

  it("converts an iPhone HEIC photo before browser decoding", async () => {
    const decoded = { width: 100, height: 200, close: vi.fn() };
    const createImageBitmap = vi.fn(async (source: Blob) => {
      if (source.type !== "image/jpeg") throw new DOMException("The source image could not be decoded.");
      return decoded;
    });
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    vi.stubGlobal("document", { createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["normalized"], { type: "image/jpeg" })),
    }) });

    const result = await prepareReceiptPage("iphone-photo", new Blob(["heic"], { type: "image/heic" }));

    expect(heic.heicTo).toHaveBeenCalledWith(expect.objectContaining({ type: "image/jpeg" }));
    expect(createImageBitmap).toHaveBeenCalledWith(expect.objectContaining({ type: "image/jpeg" }));
    expect(result.image).toEqual(expect.objectContaining({ type: "image/jpeg" }));
    expect(decoded.close).toHaveBeenCalledOnce();
  });
});
