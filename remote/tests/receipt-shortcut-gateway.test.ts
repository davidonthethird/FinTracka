import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMobileGateway, type MobileGatewayEnv } from "../src/mobileGateway";
import type { AccessClaims, AccessTokenVerifier } from "../src/mobileIdentity";

declare global {
  namespace Cloudflare {
    interface Env {
      COMMANDS: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const ORIGIN = "https://view.test";
const HOUSEHOLD = "shortcut-gateway-household";
const USER_AUD = "shortcut-user-aud";
const MAC_AUD = "shortcut-mac-aud";
const NOW = new Date("2026-11-02T12:00:00.000Z");

beforeAll(async () => {
  await applyD1Migrations(env.COMMANDS, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.COMMANDS.batch([
    env.COMMANDS.prepare("DELETE FROM receipt_shortcut_imports"),
    env.COMMANDS.prepare("DELETE FROM receipt_scan_sessions"),
    env.COMMANDS.prepare("DELETE FROM receipt_events"),
    env.COMMANDS.prepare("DELETE FROM receipt_lines"),
    env.COMMANDS.prepare("DELETE FROM receipt_revisions"),
    env.COMMANDS.prepare("DELETE FROM receipt_drafts"),
    env.COMMANDS.prepare("DELETE FROM command_events"),
    env.COMMANDS.prepare("DELETE FROM mobile_commands"),
    env.COMMANDS.prepare("DELETE FROM household_members"),
    env.COMMANDS.prepare("DELETE FROM households"),
  ]);
  await provision();
});

describe("receipt shortcut gateway", () => {
  it("keeps the feature default-off and validates same-origin session issuance", async () => {
    const gateway = makeGateway();
    const disabled = gatewayEnv(false);
    expect((await gateway.fetch(userRequest("/api/v1/mobile/receipt-scan-sessions", json({})), disabled)).status)
      .toBe(404);

    const enabled = gatewayEnv(true);
    const invalidOrigins: HeadersInit[] = [
      { Origin: "https://evil.test", "Content-Type": "application/json" },
      { Origin: ORIGIN, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of invalidOrigins) {
      const response = await gateway.fetch(userRequest("/api/v1/mobile/receipt-scan-sessions", {
        method: "POST", headers, body: "{}",
      }), enabled);
      expect(response.status).toBe(403);
    }

    const session = await gateway.fetch(userRequest(
      "/api/v1/mobile/receipt-scan-sessions", json({}),
    ), enabled);
    expect(session.status).toBe(201);
    expect(await session.json()).toMatchObject({
      contract: "receipt_scan_session/v1",
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      upload_url: `${ORIGIN}/api/v1/mobile/shortcut/receipt-imports`,
      expires_at: "2026-11-02T12:10:00.000Z",
    });
    expect(session.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("accepts one public text upload and allows only its member to retrieve and delete it", async () => {
    const gateway = makeGateway();
    const testEnv = gatewayEnv(true);
    const session = await createSession(gateway, testEnv);
    const uploaded = await gateway.fetch(shortcutRequest(capture(), session.token), testEnv);
    expect(uploaded.status).toBe(201);
    const result = await uploaded.json() as { import_id: string; review_url: string };
    expect(result.review_url).toBe(`${ORIGIN}/receipts/import/${result.import_id}`);
    expect(uploaded.headers.has("Access-Control-Allow-Origin")).toBe(false);

    const other = await gateway.fetch(userRequest(
      `/api/v1/mobile/receipt-imports/${result.import_id}`, undefined, "other-token",
    ), testEnv);
    expect(other.status).toBe(404);
    const owned = await gateway.fetch(userRequest(
      `/api/v1/mobile/receipt-imports/${result.import_id}`,
    ), testEnv);
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({ import: { id: result.import_id,
      pages: [{ text: expect.stringContaining("Synthetic Market") }] } });

    const removed = await gateway.fetch(userRequest(
      `/api/v1/mobile/receipt-imports/${result.import_id}`,
      { method: "DELETE", headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } },
    ), testEnv);
    expect(removed.status).toBe(204);
    expect((await gateway.fetch(userRequest(
      `/api/v1/mobile/receipt-imports/${result.import_id}`,
    ), testEnv)).status).toBe(404);
  });

  it("replays an identical upload and rejects changed reuse without leaking text or token", async () => {
    const gateway = makeGateway();
    const testEnv = gatewayEnv(true);
    const session = await createSession(gateway, testEnv);
    const first = await gateway.fetch(shortcutRequest(capture(), session.token), testEnv);
    const firstBody = await first.json() as { import_id: string };
    const replay = await gateway.fetch(shortcutRequest(capture(), session.token), testEnv);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ import_id: firstBody.import_id });

    const changed = await gateway.fetch(shortcutRequest({ ...capture(),
      pages: [{ page_index: 0, text: "private changed text" }] }, session.token), testEnv);
    expect(changed.status).toBe(409);
    const text = await changed.text();
    expect(text).toContain("RECEIPT_SCAN_SESSION_CONSUMED");
    expect(text).not.toContain("private changed text");
    expect(text).not.toContain(session.token);
  });

  it("rejects unauthenticated, wrong-method, wrong-type, expired, and oversized uploads safely", async () => {
    let now = NOW;
    const gateway = makeGateway(() => now);
    const testEnv = gatewayEnv(true);
    const session = await createSession(gateway, testEnv);

    const cases = [
      new Request(`${ORIGIN}/api/v1/mobile/shortcut/receipt-imports`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(capture()),
      }),
      new Request(`${ORIGIN}/api/v1/mobile/shortcut/receipt-imports`, {
        method: "GET", headers: { Authorization: `Bearer ${session.token}` },
      }),
      new Request(`${ORIGIN}/api/v1/mobile/shortcut/receipt-imports`, {
        method: "POST", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "text/plain" }, body: "{}",
      }),
      new Request(`${ORIGIN}/api/v1/mobile/shortcut/receipt-imports`, {
        method: "POST", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...capture(), padding: "x".repeat(140_000) }),
      }),
    ];
    const statuses = [];
    for (const request of cases) statuses.push((await gateway.fetch(request, testEnv)).status);
    expect(statuses).toEqual([401, 405, 415, 413]);

    now = new Date("2026-11-02T12:10:00.001Z");
    const expired = await gateway.fetch(shortcutRequest(capture(), session.token), testEnv);
    expect(expired.status).toBe(401);
    expect(await expired.text()).toContain("RECEIPT_SCAN_SESSION_EXPIRED");
  });
});

function makeGateway(clock: () => Date = () => NOW) {
  const verifier: AccessTokenVerifier = async (token, expected) => {
    const claims: Record<string, AccessClaims> = {
      "user-token": { aud: [USER_AUD], email: "david@example.test", sub: "david" },
      "other-token": { aud: [USER_AUD], email: "ariela@example.test", sub: "ariela" },
    };
    const claim = claims[token];
    if (!claim || !claim.aud.includes(expected.audience)) throw new Error("invalid token");
    return claim;
  };
  return createMobileGateway({ verifyAccessToken: verifier, now: clock });
}

function gatewayEnv(enabled: boolean): MobileGatewayEnv {
  return {
    COMMANDS: env.COMMANDS,
    SNAPSHOTS: {} as R2Bucket,
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_USER_AUD: USER_AUD,
    ACCESS_MAC_AUD: MAC_AUD,
    HOUSEHOLD_ID: HOUSEHOLD,
    HOUSEHOLD_NAME: "Shortcut gateway household",
    FEATURE_RECEIPT_DRAFTS: "true",
    FEATURE_RECEIPT_SHORTCUT: enabled ? "true" : "false",
  };
}

async function createSession(gateway: ReturnType<typeof makeGateway>, testEnv: MobileGatewayEnv) {
  const response = await gateway.fetch(userRequest(
    "/api/v1/mobile/receipt-scan-sessions", json({}),
  ), testEnv);
  expect(response.status).toBe(201);
  return response.json() as Promise<{ token: string }>;
}

function shortcutRequest(value: unknown, token: string) {
  return new Request(`${ORIGIN}/api/v1/mobile/shortcut/receipt-imports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

function capture() {
  return {
    contract: "receipt_shortcut_capture/v1",
    idempotency_key: "f3ad6254-e6ab-4a4c-bbb8-810cfde7d530",
    shortcut_version: 1,
    pages: [{ page_index: 0, text: "Synthetic Market\nITEM 10.00\nTOTAL 10.00" }],
  };
}

function userRequest(path: string, init?: RequestInit, token = "user-token") {
  const headers = new Headers(init?.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  headers.set("Cf-Access-Authenticated-User-Email",
    token === "other-token" ? "ariela@example.test" : "david@example.test");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function json(value: unknown): RequestInit {
  return { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify(value) };
}

async function provision() {
  const now = NOW.toISOString();
  await env.COMMANDS.batch([
    env.COMMANDS.prepare(
      "INSERT INTO households (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
    ).bind(HOUSEHOLD, "Shortcut gateway household", now, now),
    ...[
      ["member-david", "david@example.test", "David"],
      ["member-ariela", "ariela@example.test", "Ariela"],
    ].map(([id, email, name]) => env.COMMANDS.prepare(`INSERT INTO household_members
      (id, household_id, normalized_email, display_name, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'member', 1, ?, ?)`).bind(id, HOUSEHOLD, email, name, now, now)),
  ]);
}
