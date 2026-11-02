import type { PreparedReceiptPage } from "./types";

export interface ReceiptCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReceiptImageMetadata {
  order: number;
  rotation_degrees: 0 | 90 | 180 | 270;
  crop: ReceiptCrop | null;
}

export interface StoredReceiptImage extends ReceiptImageMetadata {
  draft_id: string;
  page_id: string;
  blob: Blob;
  updated_at: string;
}

interface StoredRow extends StoredReceiptImage { key: string }

export class ReceiptImageStoreError extends Error {
  constructor(readonly code: "quota_exceeded" | "storage_unavailable", message: string = code) {
    super(message); this.name = "ReceiptImageStoreError";
  }
}

export class ReceiptImageStore {
  constructor(
    private readonly databaseName = "fintracka-receipt-images-v1",
    private readonly factory: IDBFactory = indexedDB,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async put(draftId: string, pageId: string, blob: Blob, metadata: ReceiptImageMetadata): Promise<void> {
    try {
      const database = await this.open();
      await transactionDone(database, "readwrite", (store) => store.put({
        key: `${draftId}:${pageId}`, draft_id: draftId, page_id: pageId, blob,
        ...metadata, updated_at: this.clock().toISOString(),
      } satisfies StoredRow));
      database.close();
    } catch (error) {
      throw storageError(error);
    }
  }

  async get(draftId: string, pageId: string): Promise<StoredReceiptImage | undefined> {
    const database = await this.open();
    const row = await requestResult<StoredRow | undefined>(
      database.transaction("pages").objectStore("pages").get(`${draftId}:${pageId}`),
    );
    database.close();
    return row ? withoutKey(row) : undefined;
  }

  async list(draftId: string): Promise<StoredReceiptImage[]> {
    const database = await this.open();
    const rows = await requestResult<StoredRow[]>(
      database.transaction("pages").objectStore("pages").index("by_draft").getAll(draftId),
    );
    database.close();
    return rows.sort((left, right) => left.order - right.order).map(withoutKey);
  }

  async deleteDraft(draftId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction("pages", "readwrite");
    const index = transaction.objectStore("pages").index("by_draft");
    const keys = await requestResult<IDBValidKey[]>(index.getAllKeys(draftId));
    keys.forEach((key) => transaction.objectStore("pages").delete(key));
    await waitForTransaction(transaction);
    database.close();
  }

  async prune(days = 30): Promise<number> {
    const database = await this.open();
    const cutoff = new Date(this.clock().getTime() - days * 86_400_000).toISOString();
    const transaction = database.transaction("pages", "readwrite");
    const store = transaction.objectStore("pages");
    const rows = await requestResult<StoredRow[]>(store.getAll());
    const stale = rows.filter((row) => row.updated_at < cutoff);
    stale.forEach((row) => store.delete(row.key));
    await waitForTransaction(transaction);
    database.close();
    return stale.length;
  }

  private open(): Promise<IDBDatabase> {
    try {
      const request = this.factory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("pages", { keyPath: "key" });
        store.createIndex("by_draft", "draft_id", { unique: false });
      };
      return requestResult(request);
    } catch (error) {
      return Promise.reject(storageError(error));
    }
  }
}

export async function prepareReceiptPage(id: string, source: Blob, maxEdge = 3_200): Promise<PreparedReceiptPage> {
  const decodable = await browserDecodableImage(source);
  const bitmap = await createImageBitmap(decodable);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new ReceiptImageStoreError("storage_unavailable", "Canvas unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new ReceiptImageStoreError("storage_unavailable")),
      "image/jpeg", 0.88,
    ));
    return { id, image };
  } finally {
    bitmap.close();
  }
}

async function browserDecodableImage(source: Blob): Promise<Blob> {
  const heicMime = /^image\/hei[cf]/i.test(source.type);
  const heicName = typeof File !== "undefined" && source instanceof File && /\.hei[cf]$/i.test(source.name);
  if (!heicMime && !heicName) return source;
  const { heicTo } = await import("heic-to/csp");
  const converted = await heicTo({ blob: source, type: "image/jpeg", quality: 0.92 });
  if (!(converted instanceof Blob)) throw new ReceiptImageStoreError("storage_unavailable", "HEIC conversion failed");
  return converted;
}

function withoutKey({ key: _key, ...row }: StoredRow): StoredReceiptImage { return row; }

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function transactionDone(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<void> {
  const transaction = database.transaction("pages", mode);
  operation(transaction.objectStore("pages"));
  await waitForTransaction(transaction);
}

function storageError(error: unknown): ReceiptImageStoreError {
  if (error instanceof ReceiptImageStoreError) return error;
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new ReceiptImageStoreError("quota_exceeded", error.message);
  }
  return new ReceiptImageStoreError("storage_unavailable",
    error instanceof Error ? error.message : "Receipt image storage is unavailable");
}
