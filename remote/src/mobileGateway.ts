import { z } from "zod";

import { parseRemoteSnapshot, type RemoteSnapshot, type RemoteSnapshotV2 } from "./contract";
import {
  CommandResultSchema,
  CreateClassificationCommandSchema,
  MobileCommandStoreError,
} from "./mobileCommandModel";
import { MobileCommandStore } from "./mobileCommandStore";
import {
  resolveBrowserIdentity,
  resolveProcessorIdentity,
  verifyAccessToken,
  type AccessTokenVerifier,
} from "./mobileIdentity";

export interface MobileGatewayEnv {
  COMMANDS: D1Database;
  SNAPSHOTS: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_USER_AUD: string;
  ACCESS_MAC_AUD: string;
  HOUSEHOLD_ID: string;
  HOUSEHOLD_NAME: string;
}

interface GatewayDependencies {
  verifyAccessToken?: AccessTokenVerifier;
  now?: () => Date;
  pendingLimit?: number;
  recentLimit?: number;
}

interface ActiveManifest {
  snapshot_id: string;
  digest: string;
}

const JSON_LIMIT = 4_096;
const DEFAULT_PENDING_LIMIT = 20;
const DEFAULT_RECENT_LIMIT = 60;
const memberSchema = z.object({
  member_id: z.string().min(1).max(128),
  display_name: z.string().trim().min(1).max(80),
  email: z.string().email().max(254),
  active: z.boolean(),
}).strict();
const claimSchema = z.object({
  limit: z.int().min(1).max(10),
}).strict();
const completionSchema = z.object({
  claim_token: z.string().min(1).max(128),
  result: CommandResultSchema,
}).strict();

export function createMobileGateway(dependencies: GatewayDependencies = {}) {
  const verifier = dependencies.verifyAccessToken ?? verifyAccessToken;
  const now = dependencies.now ?? (() => new Date());
  const pendingLimit = dependencies.pendingLimit ?? DEFAULT_PENDING_LIMIT;
  const recentLimit = dependencies.recentLimit ?? DEFAULT_RECENT_LIMIT;
  return {
    async fetch(request: Request, env: MobileGatewayEnv): Promise<Response> {
      const url = new URL(request.url);
      const store = new MobileCommandStore(env.COMMANDS, now);
      try {
        if (!validSeparateAudiences(env.ACCESS_USER_AUD, env.ACCESS_MAC_AUD)) {
          return errorResponse(503, "MOBILE_AUTH_MISCONFIGURED");
        }
        if (url.pathname.startsWith("/api/v1/mobile/mac/")) {
          const identity = await resolveProcessorIdentity(request, {
            teamDomain: env.ACCESS_TEAM_DOMAIN,
            audience: env.ACCESS_MAC_AUD,
          }, verifier);
          if (!identity) return errorResponse(403, "PROCESSOR_NOT_AUTHORIZED");
          return await handleMac(request, url, env, store, identity.id);
        }
        if (!url.pathname.startsWith("/api/v1/mobile/")) {
          return errorResponse(404, "NOT_FOUND");
        }
        const identity = await resolveBrowserIdentity(request, {
          teamDomain: env.ACCESS_TEAM_DOMAIN,
          audience: env.ACCESS_USER_AUD,
        }, verifier);
        if (!identity) return errorResponse(403, "MEMBER_NOT_AUTHORIZED");
        const member = await store.resolveMember(identity.email);
        if (!member || member.household_id !== env.HOUSEHOLD_ID) {
          return errorResponse(403, "MEMBER_NOT_AUTHORIZED");
        }
        return await handleBrowser(
          request, url, env, store, member, now, pendingLimit, recentLimit,
        );
      } catch (error) {
        return mapError(error);
      }
    },
  };
}

async function handleBrowser(
  request: Request,
  url: URL,
  env: MobileGatewayEnv,
  store: MobileCommandStore,
  member: { id: string; household_id: string; display_name: string },
  now: () => Date,
  pendingLimit: number,
  recentLimit: number,
): Promise<Response> {
  if (url.pathname === "/api/v1/mobile/session") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const snapshot = await readSnapshot(env.SNAPSHOTS);
    return jsonResponse(200, {
      member: { id: member.id, display_name: member.display_name },
      capabilities: classificationEnabled(snapshot)
        ? { "transaction.set_classification": [1] }
        : {},
      server_time: new Date().toISOString(),
    });
  }
  if (url.pathname === "/api/v1/mobile/commands") {
    if (request.method === "GET") {
      return jsonResponse(200, { commands: await store.listVisible(member.household_id, 100) });
    }
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    await store.expireAndPrune();
    const input = CreateClassificationCommandSchema.safeParse(await readBrowserJson(request));
    if (!input.success) return errorResponse(400, "INVALID_COMMAND");
    const replay = await store.replayExisting(member.household_id, member.id, input.data);
    if (replay) return jsonResponse(200, replay);
    const snapshot = await readSnapshot(env.SNAPSHOTS);
    const validationError = validateAgainstSnapshot(snapshot, input.data);
    if (validationError) return errorResponse(409, validationError);
    if (input.data.replace_command_id === null
        && await store.countActive(member.household_id) >= pendingLimit) {
      return errorResponse(429, "TOO_MANY_PENDING_COMMANDS");
    }
    const oneHourAgo = new Date(now().getTime() - 60 * 60_000).toISOString();
    if (await store.countRecentForMember(member.id, oneHourAgo) >= recentLimit) {
      return errorResponse(429, "COMMAND_RATE_LIMITED");
    }
    const result = await store.createOrReplace(member.household_id, member.id, input.data);
    return jsonResponse(result.replayed ? 200 : 201, result);
  }
  const cancelMatch = url.pathname.match(/^\/api\/v1\/mobile\/commands\/([^/]+)\/cancel$/);
  if (cancelMatch) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    await store.expireAndPrune();
    await readBrowserJson(request);
    const command = await store.cancel(
      member.household_id,
      decodeURIComponent(cancelMatch[1]),
      member.id,
    );
    return jsonResponse(200, { command });
  }
  return errorResponse(404, "NOT_FOUND");
}

function validSeparateAudiences(userAudience: string, macAudience: string): boolean {
  const user = userAudience.trim();
  const mac = macAudience.trim();
  return user.length > 0 && mac.length > 0 && user !== mac;
}

async function handleMac(
  request: Request,
  url: URL,
  env: MobileGatewayEnv,
  store: MobileCommandStore,
  authenticatedProcessorId: string,
): Promise<Response> {
  if (url.pathname === "/api/v1/mobile/mac/members") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const input = memberSchema.safeParse(await readMachineJson(request));
    if (!input.success) return errorResponse(400, "INVALID_MEMBER");
    await store.upsertMember({
      householdId: env.HOUSEHOLD_ID,
      householdName: env.HOUSEHOLD_NAME,
      memberId: input.data.member_id,
      displayName: input.data.display_name,
      normalizedEmail: input.data.email,
      active: input.data.active,
    });
    return jsonResponse(200, { member_id: input.data.member_id, active: input.data.active });
  }
  if (url.pathname === "/api/v1/mobile/mac/commands/claim") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const input = claimSchema.safeParse(await readMachineJson(request));
    if (!input.success) {
      return errorResponse(400, "INVALID_CLAIM");
    }
    return jsonResponse(200, { commands: await store.claim(authenticatedProcessorId, input.data.limit) });
  }
  const completeMatch = url.pathname.match(/^\/api\/v1\/mobile\/mac\/commands\/([^/]+)\/complete$/);
  if (completeMatch) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const input = completionSchema.safeParse(await readMachineJson(request));
    if (!input.success) return errorResponse(400, "INVALID_RESULT");
    const command = await store.complete(
      decodeURIComponent(completeMatch[1]),
      input.data.claim_token,
      input.data.result,
    );
    return jsonResponse(200, { command });
  }
  return errorResponse(404, "NOT_FOUND");
}

async function readBrowserJson(request: Request): Promise<unknown> {
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) throw new GatewayError(403, "INVALID_ORIGIN");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    throw new GatewayError(403, "INVALID_ORIGIN");
  }
  return readJson(request);
}

function readMachineJson(request: Request): Promise<unknown> {
  return readJson(request);
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new GatewayError(415, "INVALID_CONTENT_TYPE");
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > JSON_LIMIT) {
    throw new GatewayError(413, "BODY_TOO_LARGE");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > JSON_LIMIT) throw new GatewayError(413, "BODY_TOO_LARGE");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new GatewayError(400, "INVALID_JSON");
  }
}

async function readSnapshot(bucket: R2Bucket): Promise<RemoteSnapshot> {
  const active = await bucket.get("active.json");
  if (!active) throw new GatewayError(409, "EDITING_UNAVAILABLE");
  const manifest = await active.json<ActiveManifest>();
  const object = await bucket.get(`snapshots/${manifest.snapshot_id}.json`);
  if (!object || object.customMetadata?.digest !== manifest.digest) {
    throw new GatewayError(409, "EDITING_UNAVAILABLE");
  }
  try {
    return parseRemoteSnapshot(JSON.parse(await object.text()));
  } catch {
    throw new GatewayError(409, "EDITING_UNAVAILABLE");
  }
}

function classificationEnabled(snapshot: RemoteSnapshot): snapshot is RemoteSnapshotV2 {
  return snapshot.schema_version === 2
    && snapshot.capabilities.commands["transaction.set_classification"]?.includes(1) === true;
}

function validateAgainstSnapshot(
  snapshot: RemoteSnapshot,
  input: z.infer<typeof CreateClassificationCommandSchema>,
): string | null {
  if (!classificationEnabled(snapshot)) return "EDITING_UNAVAILABLE";
  const target = snapshot.transactions.find((item) => item.id === input.target_id);
  if (!target) return "TARGET_NOT_FOUND";
  if (target.classification_revision !== input.observed_revision) return "STALE_CLASSIFICATION";
  if (input.category_id === null) {
    return input.subcategory_id === null ? null : "INVALID_SUBCATEGORY";
  }
  if (!snapshot.taxonomy.categories.some((item) => item.id === input.category_id)) {
    return "INVALID_CATEGORY";
  }
  if (input.subcategory_id !== null && !snapshot.taxonomy.subcategories.some(
    (item) => item.id === input.subcategory_id && item.category_id === input.category_id,
  )) {
    return "INVALID_SUBCATEGORY";
  }
  return null;
}

class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function mapError(error: unknown): Response {
  if (error instanceof GatewayError) return errorResponse(error.status, error.code);
  if (error instanceof MobileCommandStoreError) {
    const status = ["IDEMPOTENCY_CONFLICT", "ACTIVE_COMMAND_EXISTS", "REPLACE_COMMAND_NOT_FOUND",
      "COMMAND_NOT_CANCELLABLE", "COMPLETION_CONFLICT", "STALE_CLAIM"].includes(error.code)
      ? 409
      : error.code === "COMMAND_NOT_FOUND" ? 404 : 400;
    return errorResponse(status, error.code);
  }
  return errorResponse(503, "MOBILE_GATEWAY_UNAVAILABLE");
}

function methodNotAllowed(allow: string): Response {
  return errorResponse(405, "METHOD_NOT_ALLOWED", { Allow: allow });
}

function errorResponse(status: number, code: string, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify({ error_code: code }), {
    status,
    headers: responseHeaders(extra),
  });
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders() });
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

export default createMobileGateway();
