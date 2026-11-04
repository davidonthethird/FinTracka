import { z } from "zod";

import { ReceiptRefinementStore, ReceiptRefinementStoreError } from "./receiptRefinementStore";

const claimSchema = z.object({ limit: z.int().min(1).max(100) }).strict();
const completeSchema = z.object({
  claim_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  input_digest: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(1).max(100_000),
  model_result: z.string().min(1).max(100_000),
}).strict();
const failSchema = z.object({
  claim_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  error_code: z.enum(["MODEL_UNAVAILABLE", "VISION_FAILED", "INVALID_PACKAGE", "UNRECONCILED",
    "PACKAGE_NOT_FOUND"]),
}).strict();

export async function handleReceiptRefinementMac(request: Request, store: ReceiptRefinementStore) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/v1/mobile/mac/receipt-refinements")) return null;
  if (url.pathname === "/api/v1/mobile/mac/receipt-refinements/active") {
    if (request.method !== "GET") return response(405, { error_code: "METHOD_NOT_ALLOWED" }, { Allow: "GET" });
    return response(200, { refinement_ids: await store.active() });
  }
  if (request.method !== "POST") return response(405, { error_code: "METHOD_NOT_ALLOWED" }, { Allow: "POST" });
  if (url.pathname === "/api/v1/mobile/mac/receipt-refinements/claim") {
    const input = claimSchema.safeParse(await readJson(request));
    if (!input.success) return response(400, { error_code: "INVALID_REFINEMENT_CLAIM" });
    return response(200, { refinements: await store.claim(Math.min(3, input.data.limit)) });
  }
  const match = url.pathname.match(/^\/api\/v1\/mobile\/mac\/receipt-refinements\/([^/]+)\/(complete|fail)$/);
  if (!match) return response(404, { error_code: "NOT_FOUND" });
  const id = decodeURIComponent(match[1]);
  if (match[2] === "complete") {
    const input = completeSchema.safeParse(await readJson(request));
    if (!input.success) return response(400, { error_code: "INVALID_REFINEMENT_COMPLETION" });
    return response(200, await store.complete(id, input.data.claim_token, input.data.input_digest,
      input.data.text, input.data.model_result));
  }
  const input = failSchema.safeParse(await readJson(request));
  if (!input.success) return response(400, { error_code: "INVALID_REFINEMENT_FAILURE" });
  return response(200, { status: await store.fail(id, input.data.claim_token, input.data.error_code) });
}

export function mapReceiptRefinementError(error: unknown): Response | null {
  if (!(error instanceof ReceiptRefinementStoreError)) return null;
  const status = error.code.endsWith("NOT_FOUND") ? 404
    : ["REFINEMENT_CLAIM_INVALID", "REFINEMENT_INPUT_CHANGED"].includes(error.code) ? 409 : 400;
  return response(status, { error_code: error.code });
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0] !== "application/json") return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 256 * 1024) return null;
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { return null; }
}

function response(status: number, value: unknown, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: headers(extra) });
}

function headers(extra: HeadersInit = {}): Headers {
  return new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff", ...extra });
}
