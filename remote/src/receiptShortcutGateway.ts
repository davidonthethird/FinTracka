import { z } from "zod";

import { ReceiptShortcutStore, ReceiptShortcutStoreError } from "./receiptShortcutStore";

const BODY_LIMIT = 128 * 1024;
const emptyObject = z.object({}).strict();

export class ReceiptShortcutGatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function receiptShortcutEnabled(value: string | undefined): boolean {
  return value === "true";
}

export async function handleReceiptShortcutUpload(
  request: Request,
  store: ReceiptShortcutStore,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const token = bearerToken(request.headers.get("Authorization"));
  if (!token) throw new ReceiptShortcutGatewayError(401, "RECEIPT_SCAN_SESSION_INVALID");
  const input = await readJson(request, BODY_LIMIT);
  const result = await store.createImport(token, input as never);
  const origin = new URL(request.url).origin;
  return json(result.replayed ? 200 : 201, {
    import_id: result.import.id,
    review_url: `${origin}/receipts/import/${encodeURIComponent(result.import.id)}`,
    validation_status: result.import.validation?.status ?? "legacy",
    refinement_id: result.import.refinement?.id ?? null,
  });
}

export async function handleReceiptShortcutBrowser(
  request: Request,
  url: URL,
  store: ReceiptShortcutStore,
  member: { id: string; household_id: string },
): Promise<Response | null> {
  if (url.pathname === "/api/v1/mobile/receipt-scan-sessions") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const input = emptyObject.safeParse(await readBrowserJson(request, 4_096));
    if (!input.success) throw new ReceiptShortcutGatewayError(400, "INVALID_RECEIPT_SCAN_SESSION");
    const session = await store.createSession(member.household_id, member.id);
    return json(201, {
      contract: "receipt_scan_session/v1",
      shortcut_version: 2,
      shortcut_name: "FinTracka Receipt Scanner",
      token: session.token,
      upload_url: `${url.origin}/api/v1/mobile/shortcut/receipt-imports`,
      expires_at: session.expires_at,
    });
  }
  const item = url.pathname.match(/^\/api\/v1\/mobile\/receipt-imports\/([^/]+)$/);
  const retry = url.pathname.match(/^\/api\/v1\/mobile\/receipt-imports\/([^/]+)\/retry$/);
  if (retry) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    assertSameOrigin(request);
    await store.retryImport(member.household_id, member.id, decodeURIComponent(retry[1]));
    return json(200, { status: "pending" });
  }
  if (!item) return null;
  const id = decodeURIComponent(item[1]);
  if (request.method === "GET") {
    return json(200, { import: await store.getImport(member.household_id, member.id, id) });
  }
  if (request.method === "DELETE") {
    assertSameOrigin(request);
    await store.deleteImport(member.household_id, member.id, id);
    return new Response(null, { status: 204, headers: responseHeaders() });
  }
  return methodNotAllowed("GET, DELETE");
}

export function mapReceiptShortcutError(error: unknown): Response | null {
  if (error instanceof ReceiptShortcutGatewayError) return errorResponse(error.status, error.code);
  if (!(error instanceof ReceiptShortcutStoreError)) return null;
  const status = error.code === "RECEIPT_IMPORT_NOT_FOUND" ? 404
    : error.code === "MEMBER_NOT_AUTHORIZED" ? 403
      : ["RECEIPT_SCAN_SESSION_RATE_LIMITED", "TOO_MANY_RECEIPT_IMPORTS"].includes(error.code) ? 429
        : error.code === "RECEIPT_SHORTCUT_BODY_TOO_LARGE" ? 413
          : error.code === "RECEIPT_SCAN_SESSION_CONSUMED" ? 409
            : ["RECEIPT_SCAN_SESSION_INVALID", "RECEIPT_SCAN_SESSION_EXPIRED"].includes(error.code) ? 401
              : 400;
  return errorResponse(status, error.code);
}

async function readBrowserJson(request: Request, limit: number): Promise<unknown> {
  assertSameOrigin(request);
  return readJson(request, limit);
}

function assertSameOrigin(request: Request): void {
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    throw new ReceiptShortcutGatewayError(403, "INVALID_ORIGIN");
  }
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") {
    throw new ReceiptShortcutGatewayError(403, "INVALID_ORIGIN");
  }
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ReceiptShortcutGatewayError(415, "INVALID_CONTENT_TYPE");
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new ReceiptShortcutGatewayError(413, "BODY_TOO_LARGE");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) throw new ReceiptShortcutGatewayError(413, "BODY_TOO_LARGE");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ReceiptShortcutGatewayError(400, "INVALID_JSON");
  }
}

function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return match?.[1] ?? null;
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
