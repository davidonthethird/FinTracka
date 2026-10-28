import { parseRemoteSnapshot } from "./contract";
import { activateSnapshot, purgeSnapshots, StorageError } from "./storage";

interface Env {
  SNAPSHOTS: R2Bucket;
}

const MAX_BYTES = 5 * 1024 * 1024;
const headers = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/snapshots") return response(404, "NOT_FOUND");
    if (request.method === "DELETE") {
      await purgeSnapshots(env.SNAPSHOTS);
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") return response(405, "METHOD_NOT_ALLOWED");
    if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BYTES) {
      return response(413, "SNAPSHOT_TOO_LARGE");
    }
    const payload = new Uint8Array(await request.arrayBuffer());
    if (payload.byteLength > MAX_BYTES) return response(413, "SNAPSHOT_TOO_LARGE");
    const suppliedDigest = request.headers.get("X-FinTracka-Digest");
    const actualDigest = await sha256(payload);
    if (!suppliedDigest || suppliedDigest !== actualDigest) return response(400, "DIGEST_MISMATCH");
    try {
      parseRemoteSnapshot(JSON.parse(new TextDecoder().decode(payload)));
      const active = await activateSnapshot(env.SNAPSHOTS, payload, actualDigest);
      return new Response(JSON.stringify({
        snapshot_id: active.snapshot_id,
        source_sequence: active.source_sequence,
        published_at: active.published_at,
        idempotent: active.idempotent,
      }), { status: 200, headers });
    } catch (error) {
      if (error instanceof StorageError) return response(409, error.code);
      if (error instanceof SyntaxError || (error && typeof error === "object" && "issues" in error)) {
        return response(400, "INVALID_SNAPSHOT");
      }
      return response(500, "STORAGE_ERROR");
    }
  },
};

async function sha256(payload: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", payload.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function response(status: number, code: string): Response {
  return new Response(JSON.stringify({ error_code: code }), { status, headers });
}
