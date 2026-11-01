import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { ReceiptImageStore, ReceiptImageStoreError } from "../src/viewer/receipts/receiptImages";

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
});
