import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import worker from "../src/publisher";
import { activateSnapshot, purgeSnapshots } from "../src/storage";

const snapshot = (id: string, sequence: number) =>
  new TextEncoder().encode(JSON.stringify({ schema_version: 1, snapshot_id: id, source_sequence: sequence }));
const digest = (payload: Uint8Array) => createHash("sha256").update(payload).digest("hex");

class MemoryBucket {
  values = new Map<string, { body: Uint8Array; etag: string; customMetadata?: Record<string, string> }>();
  failActivation = false;
  failSnapshotWrite = false;
  failCleanup = false;

  async get(key: string) {
    const value = this.values.get(key);
    return value && {
      etag: value.etag,
      customMetadata: value.customMetadata,
      json: async () => JSON.parse(new TextDecoder().decode(value.body)),
      arrayBuffer: async () => value.body.buffer.slice(value.body.byteOffset, value.body.byteOffset + value.body.byteLength),
    };
  }

  async head(key: string) {
    const value = this.values.get(key);
    return value && { etag: value.etag, customMetadata: value.customMetadata };
  }

  async put(key: string, body: Uint8Array | string, options: any = {}) {
    if (key.startsWith("snapshots/") && this.failSnapshotWrite) throw new Error("connection lost");
    if (key === "active.json" && this.failActivation) throw new Error("ambiguous write");
    const current = this.values.get(key);
    if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const value = { body: bytes, etag: digest(bytes), customMetadata: options.customMetadata };
    this.values.set(key, value);
    return { key, etag: value.etag };
  }

  async list(options: { prefix?: string } = {}) {
    return { objects: [...this.values.keys()].filter((key) => key.startsWith(options.prefix ?? "")).map((key) => ({ key })) };
  }

  async delete(keys: string | string[]) {
    if (this.failCleanup && (typeof keys !== "string" || keys.startsWith("snapshots/"))) throw new Error("cleanup failed");
    for (const key of typeof keys === "string" ? [keys] : keys) this.values.delete(key);
  }
}

describe("atomic snapshot activation", () => {
  it("activates, replays idempotently, and retains only active plus previous", async () => {
    const bucket = new MemoryBucket();
    const one = snapshot("one", 1);
    const two = snapshot("two", 2);
    const three = snapshot("three", 3);
    expect((await activateSnapshot(bucket as any, one, digest(one))).idempotent).toBe(false);
    expect((await activateSnapshot(bucket as any, one, digest(one))).idempotent).toBe(true);
    await activateSnapshot(bucket as any, two, digest(two));
    const active = await activateSnapshot(bucket as any, three, digest(three));
    expect(active.previous_snapshot_id).toBe("two");
    expect([...bucket.values.keys()].sort()).toEqual(["active.json", "snapshots/three.json", "snapshots/two.json"]);
  });

  it("rejects lower and competing sequences", async () => {
    const bucket = new MemoryBucket();
    const current = snapshot("current", 3);
    await activateSnapshot(bucket as any, current, digest(current));
    await expect(activateSnapshot(bucket as any, snapshot("old", 2), digest(snapshot("old", 2)))).rejects.toMatchObject({ code: "SEQUENCE_CONFLICT" });
    await expect(activateSnapshot(bucket as any, snapshot("other", 3), digest(snapshot("other", 3)))).rejects.toMatchObject({ code: "SEQUENCE_CONFLICT" });
  });

  it("does not replace active state when activation fails", async () => {
    const bucket = new MemoryBucket();
    const one = snapshot("one", 1);
    await activateSnapshot(bucket as any, one, digest(one));
    bucket.failActivation = true;
    const two = snapshot("two", 2);
    await expect(activateSnapshot(bucket as any, two, digest(two))).rejects.toBeTruthy();
    expect((await bucket.get("active.json")) && await (await bucket.get("active.json"))!.json()).toMatchObject({ snapshot_id: "one" });
  });

  it("keeps the prior active snapshot when the version write loses its connection", async () => {
    const bucket = new MemoryBucket();
    const one = snapshot("one", 1);
    await activateSnapshot(bucket as any, one, digest(one));
    bucket.failSnapshotWrite = true;
    const two = snapshot("two", 2);
    await expect(activateSnapshot(bucket as any, two, digest(two))).rejects.toThrow("connection lost");
    expect(await (await bucket.get("active.json"))!.json()).toMatchObject({ snapshot_id: "one" });
  });

  it("keeps the newly activated snapshot readable when retention cleanup fails", async () => {
    const bucket = new MemoryBucket();
    for (const [id, sequence] of [["one", 1], ["two", 2]] as const) {
      const body = snapshot(id, sequence); await activateSnapshot(bucket as any, body, digest(body));
    }
    bucket.failCleanup = true;
    const three = snapshot("three", 3);
    await expect(activateSnapshot(bucket as any, three, digest(three))).rejects.toThrow("cleanup failed");
    expect(await (await bucket.get("active.json"))!.json()).toMatchObject({ snapshot_id: "three" });
    expect(await bucket.get("snapshots/three.json")).toBeTruthy();
  });

  it("purges manifests and snapshot objects", async () => {
    const bucket = new MemoryBucket();
    const body = snapshot("one", 1);
    await activateSnapshot(bucket as any, body, digest(body));
    await purgeSnapshots(bucket as any);
    expect(bucket.values.size).toBe(0);
  });
});

describe("publisher worker", () => {
  it("rejects oversized and digest-mismatched publications", async () => {
    const bucket = new MemoryBucket();
    const tooLarge = new Uint8Array(5 * 1024 * 1024 + 1);
    const oversized = await worker.fetch(new Request("https://publisher.test/v1/snapshots", { method: "POST", body: tooLarge, headers: { "X-FinTracka-Digest": digest(tooLarge) } }), { SNAPSHOTS: bucket } as any);
    expect(oversized.status).toBe(413);
    const body = snapshot("one", 1);
    const mismatch = await worker.fetch(new Request("https://publisher.test/v1/snapshots", { method: "POST", body, headers: { "X-FinTracka-Digest": "wrong" } }), { SNAPSHOTS: bucket } as any);
    expect(mismatch.status).toBe(400);
  });

  it("rejects all unrecognized routes", async () => {
    const response = await worker.fetch(new Request("https://publisher.test/anything"), { SNAPSHOTS: new MemoryBucket() } as any);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
