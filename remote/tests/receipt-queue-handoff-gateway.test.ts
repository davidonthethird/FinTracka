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
const HOUSEHOLD = "queue-gateway-household";
const USER_AUD = "queue-user-aud";
const MAC_AUD = "queue-mac-aud";
const START = new Date("2026-11-11T12:00:00.000Z");

beforeAll(async () => applyD1Migrations(env.COMMANDS, env.TEST_MIGRATIONS));

beforeEach(async () => {
  await env.COMMANDS.batch([
    env.COMMANDS.prepare("DELETE FROM receipt_queue_handoffs"),
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

describe("receipt queue handoff gateway", () => {
  it("advertises a token-free v4 handoff and scopes its status to the owning member", async () => {
    const gateway = makeGateway();
    const response = await gateway.fetch(userRequest("/api/v1/mobile/receipt-scan-sessions", json({})),
      gatewayEnv(true));

    expect(response.status).toBe(201);
    const created = await response.json() as Record<string, unknown>;
    expect(created).toEqual({
      contract: "receipt_queue_handoff/v1",
      shortcut_version: 4,
      comparison_enabled: true,
      shortcut_name: "FinTracka Receipt Scanner",
      handoff_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expires_at: "2026-11-18T12:00:00.000Z",
    });
    expect(created).not.toHaveProperty("token");
    expect(created).not.toHaveProperty("upload_url");

    const id = String(created.handoff_id);
    const list = await gateway.fetch(userRequest("/api/v1/mobile/receipt-queue-handoffs"), gatewayEnv(true));
    expect(await list.json()).toEqual({ handoffs: [{
      id, status: "pending", created_at: START.toISOString(),
      expires_at: "2026-11-18T12:00:00.000Z",
    }] });
    expect((await gateway.fetch(userRequest(`/api/v1/mobile/receipt-queue-handoffs/${id}`,
      undefined, "ariela-token"), gatewayEnv(true))).status).toBe(404);
  });

  it("requires the Mac Access identity and completes one strict capture idempotently", async () => {
    const gateway = makeGateway();
    const testEnv = gatewayEnv(true);
    const handoff = await createHandoff(gateway, testEnv);

    expect((await gateway.fetch(new Request(`${ORIGIN}/api/v1/mobile/mac/receipt-queue-handoffs/active`),
      testEnv)).status).toBe(403);
    expect((await gateway.fetch(userRequest("/api/v1/mobile/mac/receipt-queue-handoffs/active"),
      testEnv)).status).toBe(403);

    const active = await gateway.fetch(macRequest("/api/v1/mobile/mac/receipt-queue-handoffs/active"), testEnv);
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({ handoff_ids: [handoff.id] });

    const path = `/api/v1/mobile/mac/receipt-queue-handoffs/${handoff.id}/complete`;
    const first = await gateway.fetch(macRequest(path, macJson(capture())), testEnv);
    expect(first.status).toBe(201);
    const completed = await first.json() as { review_path: string };
    expect(completed.review_path).toMatch(/^\/receipts\/import\/[0-9a-f-]{36}$/);

    const replay = await gateway.fetch(macRequest(path, macJson(capture())), testEnv);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(completed);
    const changed = await gateway.fetch(macRequest(path, macJson({
      ...capture(), text: "Changed\nTOTAL 12.00",
    })), testEnv);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error_code: "RECEIPT_QUEUE_HANDOFF_CHANGED" });

    const status = await gateway.fetch(userRequest(
      `/api/v1/mobile/receipt-queue-handoffs/${handoff.id}`), testEnv);
    expect(await status.json()).toEqual({ handoff: {
      id: handoff.id, status: "ready", created_at: START.toISOString(),
      expires_at: "2026-11-18T12:00:00.000Z", review_path: completed.review_path,
    } });
  });

  it("rejects oversized bodies and expired handoffs without exposing imports", async () => {
    let now = START;
    const gateway = makeGateway(() => now);
    const testEnv = gatewayEnv(true);
    const handoff = await createHandoff(gateway, testEnv);
    const path = `/api/v1/mobile/mac/receipt-queue-handoffs/${handoff.id}/complete`;

    const oversized = await gateway.fetch(macRequest(path, macJson({ padding: "x".repeat(262_200) })), testEnv);
    expect(oversized.status).toBe(413);
    now = new Date("2026-11-18T12:00:00.001Z");
    const expired = await gateway.fetch(macRequest(path, macJson(capture())), testEnv);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error_code: "RECEIPT_QUEUE_HANDOFF_EXPIRED" });
  });

  it("keeps legacy upload sessions available while v4 advertisement is off", async () => {
    const gateway = makeGateway();
    const testEnv = gatewayEnv(false);
    const session = await gateway.fetch(userRequest("/api/v1/mobile/receipt-scan-sessions", json({})), testEnv);
    const body = await session.json() as { token: string; shortcut_version: number; upload_url: string };
    expect(body).toMatchObject({ shortcut_version: 3,
      upload_url: `${ORIGIN}/api/v1/mobile/shortcut/receipt-imports` });
    const uploaded = await gateway.fetch(shortcutRequest(capture(), body.token), testEnv);
    expect(uploaded.status).toBe(201);
  });
});

function makeGateway(clock: () => Date = () => START) {
  const verifyAccessToken: AccessTokenVerifier = async (token, expected) => {
    const claims: Record<string, AccessClaims> = {
      "david-token": { aud: [USER_AUD], email: "david@example.test", sub: "david" },
      "ariela-token": { aud: [USER_AUD], email: "ariela@example.test", sub: "ariela" },
      "mac-token": { aud: [MAC_AUD], common_name: "fintracka-mac", sub: "mac" },
    };
    const claim = claims[token];
    if (!claim || !claim.aud.includes(expected.audience)) throw new Error("invalid token");
    return claim;
  };
  return createMobileGateway({ verifyAccessToken, now: clock });
}

function gatewayEnv(advertise: boolean): MobileGatewayEnv {
  return {
    COMMANDS: env.COMMANDS,
    SNAPSHOTS: {} as R2Bucket,
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_USER_AUD: USER_AUD,
    ACCESS_MAC_AUD: MAC_AUD,
    HOUSEHOLD_ID: HOUSEHOLD,
    HOUSEHOLD_NAME: "Queue gateway household",
    FEATURE_RECEIPT_DRAFTS: "false",
    FEATURE_RECEIPT_SHORTCUT: "true",
    FEATURE_RECEIPT_MODEL_COMPARISON: "true",
    FEATURE_RECEIPT_QUEUE_HANDOFF_ADVERTISE: advertise ? "true" : "false",
  };
}

async function createHandoff(gateway: ReturnType<typeof makeGateway>, testEnv: MobileGatewayEnv) {
  const response = await gateway.fetch(userRequest("/api/v1/mobile/receipt-scan-sessions", json({})), testEnv);
  expect(response.status).toBe(201);
  const body = await response.json() as { handoff_id: string };
  return { id: body.handoff_id };
}

function capture() {
  const model_result = JSON.stringify({
    merchant: { value: "Synthetic Market", evidence: "Synthetic Market" },
    date: null, subtotal: null, discounts: [], tax: null, tip: null, fees: [],
    total: { value_cents: 1000, evidence: "TOTAL 10.00" },
    lines: [{ description: "ITEM", amount_cents: 1000,
      description_evidence: "ITEM 10.00", amount_evidence: "ITEM 10.00" }],
  });
  return {
    contract: "receipt_shortcut_capture/v3",
    idempotency_key: "a".repeat(64), shortcut_version: 3,
    text: "Synthetic Market\nITEM 10.00\nTOTAL 10.00",
    runs: [
      { model: "on_device", status: "completed", duration_ms: 1000, model_result },
      { model: "private_cloud_compute", status: "completed", duration_ms: 2000, model_result },
    ],
  };
}

function userRequest(path: string, init?: RequestInit, token = "david-token") {
  const headers = new Headers(init?.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  headers.set("Cf-Access-Authenticated-User-Email",
    token === "ariela-token" ? "ariela@example.test" : "david@example.test");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function macRequest(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cf-Access-Jwt-Assertion", "mac-token");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function json(value: unknown): RequestInit {
  return { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify(value) };
}

function macJson(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value) };
}

function shortcutRequest(value: unknown, token: string) {
  return new Request(`${ORIGIN}/api/v1/mobile/shortcut/receipt-imports`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`,
      "Content-Type": "application/json" }, body: JSON.stringify(value),
  });
}

async function provision() {
  const now = START.toISOString();
  await env.COMMANDS.batch([
    env.COMMANDS.prepare(
      "INSERT INTO households (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
    ).bind(HOUSEHOLD, "Queue gateway household", now, now),
    ...[
      ["member-david", "david@example.test", "David"],
      ["member-ariela", "ariela@example.test", "Ariela"],
    ].map(([id, email, name]) => env.COMMANDS.prepare(`INSERT INTO household_members
      (id, household_id, normalized_email, display_name, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'member', 1, ?, ?)`).bind(id, HOUSEHOLD, email, name, now, now)),
  ]);
}
