import { z } from "zod";

import { ReceiptStore, ReceiptStoreError } from "./receiptStore";

const BODY_LIMIT = 256 * 1024;
const dismissSchema = z.object({ expected_revision: z.int().min(1) }).strict();

export class ReceiptGatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function receiptDraftsEnabled(value: string | undefined): boolean {
  return value === "true";
}

export async function handleReceiptBrowser(
  request: Request,
  url: URL,
  store: ReceiptStore,
  member: { id: string; household_id: string },
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/v1/mobile/receipts")) return null;
  if (url.pathname === "/api/v1/mobile/receipts") {
    if (request.method === "GET") return json(200, { drafts: await store.list(member.household_id) });
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    const result = await store.create(member.household_id, member.id, await readBrowserJson(request));
    return json(result.replayed ? 200 : 201, result);
  }
  const dismiss = url.pathname.match(/^\/api\/v1\/mobile\/receipts\/([^/]+)\/dismiss$/);
  if (dismiss) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const input = dismissSchema.safeParse(await readBrowserJson(request));
    if (!input.success) throw new ReceiptGatewayError(400, "INVALID_RECEIPT_DISMISSAL");
    const draft = await store.dismiss(member.household_id, member.id,
      decodeURIComponent(dismiss[1]), input.data.expected_revision);
    return json(200, { draft });
  }
  const item = url.pathname.match(/^\/api\/v1\/mobile\/receipts\/([^/]+)$/);
  if (!item) return jsonError(404, "NOT_FOUND");
  const id = decodeURIComponent(item[1]);
  if (request.method === "GET") return json(200, { draft: await store.get(member.household_id, id) });
  if (request.method !== "PUT") return methodNotAllowed("GET, PUT");
  const result = await store.replace(member.household_id, member.id, id, await readBrowserJson(request));
  return json(200, result);
}

export async function handleReceiptMac(
  request: Request,
  url: URL,
  store: ReceiptStore,
  householdId: string,
): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/v1\/mobile\/mac\/receipts\/([^/]+)$/);
  if (!match) return null;
  if (request.method !== "GET") return methodNotAllowed("GET");
  const revision = Number(url.searchParams.get("revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ReceiptGatewayError(400, "INVALID_RECEIPT_REVISION");
  }
  return json(200, { revision: await store.getImmutableRevision(
    householdId, decodeURIComponent(match[1]), revision,
  ) });
}

async function readBrowserJson(request: Request): Promise<unknown> {
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) throw new ReceiptGatewayError(403, "INVALID_ORIGIN");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    throw new ReceiptGatewayError(403, "INVALID_ORIGIN");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ReceiptGatewayError(415, "INVALID_CONTENT_TYPE");
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > BODY_LIMIT) throw new ReceiptGatewayError(413, "BODY_TOO_LARGE");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_LIMIT) throw new ReceiptGatewayError(413, "BODY_TOO_LARGE");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ReceiptGatewayError(400, "INVALID_JSON");
  }
}

export function mapReceiptError(error: unknown): Response | null {
  if (error instanceof ReceiptGatewayError) return jsonError(error.status, error.code);
  if (!(error instanceof ReceiptStoreError)) return null;
  const status = error.code === "RECEIPT_NOT_FOUND" || error.code === "RECEIPT_REVISION_NOT_FOUND"
    ? 404
    : error.code === "RECEIPT_WRITE_RATE_LIMITED" || error.code === "TOO_MANY_ACTIVE_RECEIPTS"
      ? 429
      : error.code.includes("CONFLICT") || error.code === "RECEIPT_NOT_DISMISSIBLE"
        ? 409
        : error.code === "MEMBER_NOT_AUTHORIZED" ? 403 : 400;
  return jsonError(status, error.code);
}

function methodNotAllowed(allow: string): Response {
  return jsonError(405, "METHOD_NOT_ALLOWED", { Allow: allow });
}

function jsonError(status: number, code: string, extra: HeadersInit = {}): Response {
  return json(status, { error_code: code }, extra);
}

function json(status: number, value: unknown, extra: HeadersInit = {}): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  });
  headers.delete("Access-Control-Allow-Origin");
  return new Response(JSON.stringify(value), { status, headers });
}
