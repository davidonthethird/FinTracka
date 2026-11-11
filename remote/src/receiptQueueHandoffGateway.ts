import {
  ReceiptQueueHandoffStore,
  ReceiptQueueHandoffStoreError,
  type ReceiptQueueHandoff,
} from "./receiptQueueHandoffStore";

const BODY_LIMIT = 256 * 1024;

export class ReceiptQueueHandoffGatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export async function handleReceiptQueueHandoffBrowser(
  request: Request,
  url: URL,
  store: ReceiptQueueHandoffStore,
  member: { id: string; household_id: string },
): Promise<Response | null> {
  if (url.pathname === "/api/v1/mobile/receipt-queue-handoffs") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const handoffs = await store.listForMember(member.household_id, member.id);
    return json(200, { handoffs: handoffs.map(browserHandoff) });
  }
  const match = url.pathname.match(/^\/api\/v1\/mobile\/receipt-queue-handoffs\/([^/]+)$/);
  if (!match) return null;
  if (request.method !== "GET") return methodNotAllowed("GET");
  const handoff = await store.get(member.household_id, member.id, decodeURIComponent(match[1]));
  return json(200, { handoff: browserHandoff(handoff) });
}

export async function handleReceiptQueueHandoffMac(
  request: Request,
  url: URL,
  store: ReceiptQueueHandoffStore,
): Promise<Response | null> {
  if (url.pathname === "/api/v1/mobile/mac/receipt-queue-handoffs/active") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json(200, { handoff_ids: [...await store.listActiveIds()] });
  }
  const match = url.pathname.match(
    /^\/api\/v1\/mobile\/mac\/receipt-queue-handoffs\/([^/]+)\/complete$/,
  );
  if (!match) return null;
  if (request.method !== "POST") return methodNotAllowed("POST");
  const result = await store.complete(
    decodeURIComponent(match[1]),
    await readJson(request, BODY_LIMIT),
  );
  return json(result.replayed ? 200 : 201, {
    review_path: `/receipts/import/${encodeURIComponent(result.import.id)}`,
  });
}

export function mapReceiptQueueHandoffError(error: unknown): Response | null {
  if (error instanceof ReceiptQueueHandoffGatewayError) return errorResponse(error.status, error.code);
  if (!(error instanceof ReceiptQueueHandoffStoreError)) return null;
  const status = error.code === "RECEIPT_QUEUE_HANDOFF_NOT_FOUND" ? 404
    : error.code === "RECEIPT_QUEUE_HANDOFF_EXPIRED" ? 410
      : error.code === "RECEIPT_QUEUE_HANDOFF_CHANGED" ? 409
        : error.code === "RECEIPT_QUEUE_HANDOFF_CREATE_FAILED" ? 503
          : 400;
  return errorResponse(status, error.code);
}

function browserHandoff(handoff: ReceiptQueueHandoff) {
  const base = {
    id: handoff.id,
    status: handoff.status === "completed" ? "ready" : handoff.status,
    created_at: handoff.createdAt,
    expires_at: handoff.expiresAt,
  };
  if (handoff.status === "completed" && handoff.importId) {
    return { ...base, review_path: `/receipts/import/${encodeURIComponent(handoff.importId)}` };
  }
  if (handoff.status === "failed" && handoff.errorCode) {
    return { ...base, error_code: handoff.errorCode };
  }
  return base;
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase()
      !== "application/json") {
    throw new ReceiptQueueHandoffGatewayError(415, "INVALID_CONTENT_TYPE");
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new ReceiptQueueHandoffGatewayError(413, "BODY_TOO_LARGE");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) throw new ReceiptQueueHandoffGatewayError(413, "BODY_TOO_LARGE");
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    throw new ReceiptQueueHandoffGatewayError(400, "INVALID_JSON");
  }
}

function methodNotAllowed(allow: string): Response {
  return errorResponse(405, "METHOD_NOT_ALLOWED", { Allow: allow });
}

function errorResponse(status: number, code: string, extra: HeadersInit = {}): Response {
  return json(status, { error_code: code }, extra);
}

function json(status: number, value: unknown, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders(extra) });
}

function responseHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  });
  headers.delete("Access-Control-Allow-Origin");
  return headers;
}
