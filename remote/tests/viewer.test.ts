import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import viewer from "../src/viewer";

const fixture = readFileSync("../tests/fixtures/remote_snapshot_v1.json");
const document = JSON.parse(fixture.toString());

class Bucket {
  active: Record<string, unknown> | null = null;
  snapshot: Uint8Array | null = null;
  digest = "fixture-digest";
  fail = false;

  async get(key: string) {
    if (this.fail) throw new Error("private R2 detail");
    if (key === "active.json") return this.active && { json: async () => this.active };
    if (!this.snapshot) return null;
    return {
      customMetadata: { digest: this.digest },
      arrayBuffer: async () => this.snapshot!.buffer.slice(
        this.snapshot!.byteOffset,
        this.snapshot!.byteOffset + this.snapshot!.byteLength,
      ),
    };
  }
}

const assets = {
  fetch: async () => new Response("viewer asset", { headers: { "Content-Type": "text/html" } }),
};

function env(bucket: Bucket) {
  return { SNAPSHOTS: bucket, ASSETS: assets } as any;
}

function readyBucket() {
  const bucket = new Bucket();
  bucket.snapshot = fixture;
  bucket.active = {
    snapshot_id: document.snapshot_id,
    source_sequence: document.source_sequence,
    digest: bucket.digest,
    published_at: "2026-10-27T12:01:00Z",
    previous_snapshot_id: null,
  };
  return bucket;
}

describe("viewer worker", () => {
  it("reports no snapshot without exposing storage details", async () => {
    const bucket = new Bucket();
    const status = await viewer.fetch(new Request("https://view.test/api/v1/status"), env(bucket));
    expect(await status.json()).toEqual({ available: false });
    const snapshot = await viewer.fetch(new Request("https://view.test/api/v1/snapshot"), env(bucket));
    expect(snapshot.status).toBe(404);
  });

  it("serves the exact active snapshot and metadata-only status", async () => {
    const bucket = readyBucket();
    const snapshot = await viewer.fetch(new Request("https://view.test/api/v1/snapshot"), env(bucket));
    expect(new Uint8Array(await snapshot.arrayBuffer())).toEqual(new Uint8Array(fixture));
    const status = await viewer.fetch(new Request("https://view.test/api/v1/status"), env(bucket));
    const body = await status.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      available: true,
      schema_version: 1,
      source_sequence: document.source_sequence,
      history_start: document.history_start,
      history_end: document.history_end,
      counts: document.counts,
      published_at: "2026-10-27T12:01:00Z",
    });
    expect(body).not.toHaveProperty("transactions");
    expect(body.stale).toBe(true);
  });

  it("handles HEAD without a response body", async () => {
    const response = await viewer.fetch(new Request("https://view.test/api/v1/snapshot", { method: "HEAD" }), env(readyBucket()));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("rejects %s", async (method) => {
    const response = await viewer.fetch(new Request("https://view.test/api/v1/snapshot", { method }), env(readyBucket()));
    expect(response.status).toBe(405);
  });

  it("rejects traversal and applies security headers", async () => {
    const response = await viewer.fetch(new Request("https://view.test/%252e%252e/private"), env(readyBucket()));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("redacts missing, mismatched, and failed storage reads", async () => {
    const missing = readyBucket();
    missing.snapshot = null;
    expect((await viewer.fetch(new Request("https://view.test/api/v1/snapshot"), env(missing))).status).toBe(503);
    const mismatch = readyBucket();
    mismatch.digest = "different";
    expect((await viewer.fetch(new Request("https://view.test/api/v1/snapshot"), env(mismatch))).status).toBe(503);
    const failed = readyBucket();
    failed.fail = true;
    const response = await viewer.fetch(new Request("https://view.test/api/v1/status"), env(failed));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private R2 detail");
  });

  it("serves static assets through the assets binding", async () => {
    const response = await viewer.fetch(new Request("https://view.test/overview"), env(readyBucket()));
    expect(await response.text()).toBe("viewer asset");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
