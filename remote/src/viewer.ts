interface Env {
  SNAPSHOTS: R2Bucket;
  ASSETS: Fetcher;
}

interface Manifest {
  snapshot_id: string;
  source_sequence: number;
  digest: string;
  published_at: string;
}

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (hasTraversal(request.url)) return errorResponse(400, "INVALID_PATH");
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: secureHeaders({ Allow: "GET, HEAD, OPTIONS" }) });
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return errorResponse(405, "METHOD_NOT_ALLOWED", { Allow: "GET, HEAD, OPTIONS" });
    }
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname === "/api/v1/snapshot") {
        const active = await readActive(env.SNAPSHOTS);
        if (!active) return errorResponse(404, "SNAPSHOT_UNAVAILABLE");
        const result = new Response(
          request.method === "HEAD" ? null : active.payload.slice().buffer as ArrayBuffer,
          { status: 200, headers: secureHeaders({ "Content-Type": "application/json; charset=utf-8", ETag: `"${active.manifest.digest}"` }) },
        );
        return result;
      }
      if (pathname === "/api/v1/status") {
        const active = await readActive(env.SNAPSHOTS);
        if (!active) return jsonResponse(200, { available: false }, request.method === "HEAD");
        const snapshot = JSON.parse(new TextDecoder().decode(active.payload)) as Record<string, unknown>;
        const capturedAt = String(snapshot.captured_at);
        return jsonResponse(200, {
          available: true,
          schema_version: snapshot.schema_version,
          source_sequence: active.manifest.source_sequence,
          captured_at: capturedAt,
          source_last_sync_at: snapshot.source_last_sync_at,
          published_at: active.manifest.published_at,
          history_start: snapshot.history_start,
          history_end: snapshot.history_end,
          counts: snapshot.counts,
          stale: Date.now() - Date.parse(capturedAt) > 2 * 60 * 60 * 1000,
        }, request.method === "HEAD");
      }
      if (pathname.startsWith("/api/")) return errorResponse(404, "NOT_FOUND");
      const asset = await env.ASSETS.fetch(request);
      return withSecurityHeaders(asset, request.method === "HEAD");
    } catch {
      return errorResponse(503, "VIEWER_STORAGE_UNAVAILABLE");
    }
  },
};

async function readActive(bucket: R2Bucket): Promise<{
  manifest: Manifest;
  payload: Uint8Array;
} | null> {
  const active = await bucket.get("active.json");
  if (!active) return null;
  const manifest = await active.json<Manifest>();
  const object = await bucket.get(`snapshots/${manifest.snapshot_id}.json`);
  if (!object || object.customMetadata?.digest !== manifest.digest) {
    throw new Error("active snapshot is unavailable");
  }
  return { manifest, payload: new Uint8Array(await object.arrayBuffer()) };
}

function hasTraversal(rawUrl: string): boolean {
  let path = rawUrl.slice(rawUrl.indexOf("/", rawUrl.indexOf("//") + 2));
  for (let index = 0; index < 2; index += 1) {
    try { path = decodeURIComponent(path); } catch { return true; }
  }
  return path.split(/[/?#]/).includes("..");
}

function errorResponse(status: number, code: string, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify({ error_code: code }), {
    status,
    headers: secureHeaders({ "Content-Type": "application/json; charset=utf-8", ...extra }),
  });
}

function jsonResponse(status: number, value: unknown, head: boolean): Response {
  return new Response(head ? null : JSON.stringify(value), {
    status,
    headers: secureHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

function secureHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(securityHeaders);
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return headers;
}

async function withSecurityHeaders(response: Response, head: boolean): Promise<Response> {
  const headers = secureHeaders(response.headers);
  return new Response(head ? null : response.body, { status: response.status, headers });
}
