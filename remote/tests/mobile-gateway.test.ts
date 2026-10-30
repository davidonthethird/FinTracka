import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import snapshotV1 from "../../tests/fixtures/remote_snapshot_v1.json";
import snapshotV2 from "../../tests/fixtures/remote_snapshot_v2.json";
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

const HOUSEHOLD = "household-test";
const USER_AUD = "viewer-user-aud";
const MAC_AUD = "viewer-mac-aud";
const ORIGIN = "https://view.test";

beforeAll(async () => {
  await applyD1Migrations(env.COMMANDS, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.COMMANDS.batch([
    env.COMMANDS.prepare("DELETE FROM command_events"),
    env.COMMANDS.prepare("DELETE FROM mobile_commands"),
    env.COMMANDS.prepare("DELETE FROM household_members"),
    env.COMMANDS.prepare("DELETE FROM households"),
  ]);
});

describe("mobile gateway", () => {
  it("resolves a signed user identity without returning the email", async () => {
    const gateway = makeGateway();
    await provision(gateway);

    const response = await gateway.fetch(userRequest("/api/v1/mobile/session"), gatewayEnv());
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      member: { id: "member-david", display_name: "David" },
      capabilities: { "transaction.set_classification": [1, 2] },
    });
    expect(JSON.stringify(body)).not.toContain("david@example.test");
  });

  it("negotiates v2 scope and rejects malformed versioned commands", async () => {
    const gateway = makeGateway();
    await provision(gateway);
    const document = structuredClone(snapshotV2) as any;
    document.capabilities.commands["transaction.set_classification"] = [1, 2];
    const testEnv = gatewayEnv(document);

    const session = await gateway.fetch(userRequest("/api/v1/mobile/session"), testEnv);
    expect(await session.json()).toMatchObject({
      capabilities: { "transaction.set_classification": [1, 2] },
    });
    const created = await gateway.fetch(userRequest("/api/v1/mobile/commands", json(command({
      command_version: 2,
      scope: "past_and_future",
    }))), testEnv);
    expect(created.status).toBe(201);
    expect((await created.json() as any).command).toMatchObject({
      command_version: 2,
      scope: "past_and_future",
    });
    const claimed = await gateway.fetch(macRequest(
      "/api/v1/mobile/mac/commands/claim", json({ limit: 1 }),
    ), testEnv);
    expect((await claimed.json() as any).commands[0]).toMatchObject({
      command_version: 2,
      scope: "past_and_future",
    });

    for (const malformed of [
      command({ command_version: 2 }),
      command({ command_version: 2, scope: "everywhere" }),
      command({ command_version: 1, scope: "past_and_future" }),
    ]) {
      await expectError(
        await gateway.fetch(userRequest("/api/v1/mobile/commands", json(malformed)), testEnv),
        400,
        "INVALID_COMMAND",
      );
    }
  });

  it("rejects missing, spoofed, unknown, and inactive browser identities", async () => {
    const gateway = makeGateway();
    await provision(gateway);

    const missing = await gateway.fetch(new Request(`${ORIGIN}/api/v1/mobile/session`), gatewayEnv());
    await expectError(missing, 403, "MEMBER_NOT_AUTHORIZED");

    const spoofed = await gateway.fetch(new Request(`${ORIGIN}/api/v1/mobile/session`, {
      headers: { "Cf-Access-Authenticated-User-Email": "david@example.test" },
    }), gatewayEnv());
    await expectError(spoofed, 403, "MEMBER_NOT_AUTHORIZED");

    const unknown = await gateway.fetch(userRequest("/api/v1/mobile/session", undefined, "unknown-user"), gatewayEnv());
    await expectError(unknown, 403, "MEMBER_NOT_AUTHORIZED");

    await provision(gateway, false);
    const inactive = await gateway.fetch(userRequest("/api/v1/mobile/session"), gatewayEnv());
    await expectError(inactive, 403, "MEMBER_NOT_AUTHORIZED");
  });

  it("keeps user and Mac application audiences separate", async () => {
    const gateway = makeGateway();
    await provision(gateway);

    await expectError(
      await gateway.fetch(macRequest("/api/v1/mobile/session"), gatewayEnv()),
      403,
      "MEMBER_NOT_AUTHORIZED",
    );
    await expectError(
      await gateway.fetch(userRequest("/api/v1/mobile/mac/commands/claim", json({ limit: 1 })), gatewayEnv()),
      403,
      "PROCESSOR_NOT_AUTHORIZED",
    );
  });

  it("fails closed when browser and Mac audiences are configured identically", async () => {
    const gateway = makeGateway();
    const misconfigured = gatewayEnv();
    misconfigured.ACCESS_MAC_AUD = misconfigured.ACCESS_USER_AUD;

    await expectError(
      await gateway.fetch(userRequest("/api/v1/mobile/session"), misconfigured),
      503,
      "MOBILE_AUTH_MISCONFIGURED",
    );
    await expectError(
      await gateway.fetch(macRequest("/api/v1/mobile/mac/commands/claim", json({ limit: 1 })), misconfigured),
      503,
      "MOBILE_AUTH_MISCONFIGURED",
    );
  });

  it("requires same-origin bounded JSON for browser mutations", async () => {
    const gateway = makeGateway();
    await provision(gateway);
    const body = command();

    for (const request of [
      userRequest("/api/v1/mobile/commands", { method: "POST", body: JSON.stringify(body) }),
      userRequest("/api/v1/mobile/commands", json(body, { Origin: "https://evil.test" })),
      userRequest("/api/v1/mobile/commands", json(body, { "Sec-Fetch-Site": "cross-site" })),
      userRequest("/api/v1/mobile/commands", json(body, { "Content-Type": "text/plain" })),
      userRequest("/api/v1/mobile/commands", json({ padding: "x".repeat(5_000) })),
    ]) {
      expect((await gateway.fetch(request, gatewayEnv())).status).toBeGreaterThanOrEqual(400);
    }
    const options = await gateway.fetch(userRequest("/api/v1/mobile/commands", { method: "OPTIONS" }), gatewayEnv());
    expect(options.status).toBe(405);
    expect(options.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("leaves v1 and capability-disabled snapshots read-only", async () => {
    const gateway = makeGateway();
    await provision(gateway);
    const v1 = gatewayEnv(snapshotV1);
    const session = await gateway.fetch(userRequest("/api/v1/mobile/session"), v1);
    expect(await session.json()).toMatchObject({ capabilities: {} });
    await expectError(
      await gateway.fetch(userRequest("/api/v1/mobile/commands", json(command())), v1),
      409,
      "EDITING_UNAVAILABLE",
    );

    const disabled = structuredClone(snapshotV2) as any;
    disabled.capabilities.commands = {};
    await expectError(
      await gateway.fetch(userRequest("/api/v1/mobile/commands", json(command())), gatewayEnv(disabled)),
      409,
      "EDITING_UNAVAILABLE",
    );
  });

  it("validates target revision and active taxonomy from the committed snapshot", async () => {
    const gateway = makeGateway();
    await provision(gateway);

    const cases = [
      [command({ target_id: "missing" }), "TARGET_NOT_FOUND"],
      [command({ observed_revision: 99 }), "STALE_CLASSIFICATION"],
      [command({ category_id: "missing", subcategory_id: null }), "INVALID_CATEGORY"],
      [command({ subcategory_id: "missing-subcategory" }), "INVALID_SUBCATEGORY"],
    ] as const;
    for (const [payload, code] of cases) {
      const response = await gateway.fetch(userRequest("/api/v1/mobile/commands", json(payload)), gatewayEnv());
      await expectError(response, 409, code);
    }
  });

  it("creates, replays, replaces, lists, and cancels commands safely", async () => {
    const gateway = makeGateway();
    await provision(gateway);

    const created = await gateway.fetch(
      userRequest("/api/v1/mobile/commands", json(command())), gatewayEnv(),
    );
    expect(created.status).toBe(201);
    const first = await created.json() as any;
    expect(first.replayed).toBe(false);
    expect(first.command.status).toBe("pending");

    const replay = await gateway.fetch(
      userRequest("/api/v1/mobile/commands", json(command())), gatewayEnv(),
    );
    expect(replay.status).toBe(200);
    expect((await replay.json() as any).replayed).toBe(true);

    await expectError(
      await gateway.fetch(userRequest("/api/v1/mobile/commands", json(command({
        idempotency_key: "mobile-command-02",
      }))), gatewayEnv()),
      409,
      "ACTIVE_COMMAND_EXISTS",
    );

    const replacement = await gateway.fetch(userRequest("/api/v1/mobile/commands", json(command({
      idempotency_key: "mobile-command-03",
      replace_command_id: first.command.id,
      category_id: null,
      subcategory_id: null,
    }))), gatewayEnv());
    expect(replacement.status).toBe(201);

    const listed = await gateway.fetch(userRequest("/api/v1/mobile/commands"), gatewayEnv());
    const commands = (await listed.json() as any).commands;
    expect(commands.map((item: any) => item.status)).toEqual(["pending", "superseded"]);
    expect(JSON.stringify(commands)).not.toContain("Fixture merchant");

    const pendingId = commands[0].id;
    const cancelled = await gateway.fetch(userRequest(
      `/api/v1/mobile/commands/${pendingId}/cancel`, json({}),
    ), gatewayEnv());
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json() as any).command.status).toBe("cancelled");
  });

  it("replays an applied idempotency key before validating a newer snapshot", async () => {
    const gateway = makeGateway();
    await provision(gateway);
    const original = command();
    const first = await gateway.fetch(
      userRequest("/api/v1/mobile/commands", json(original)), gatewayEnv(),
    );
    const created = await first.json() as any;
    const claim = await gateway.fetch(macRequest(
      "/api/v1/mobile/mac/commands/claim", json({ limit: 1 }),
    ), gatewayEnv());
    const claimed = (await claim.json() as any).commands[0];
    await gateway.fetch(macRequest(
      `/api/v1/mobile/mac/commands/${created.command.id}/complete`,
      json({ claim_token: claimed.claim_token, result: {
        status: "applied", category_id: original.category_id,
        subcategory_id: original.subcategory_id, classification_revision: 1,
      } }),
    ), gatewayEnv());

    const newer = structuredClone(snapshotV2) as any;
    newer.transactions[0].classification_revision = 1;
    const replay = await gateway.fetch(
      userRequest("/api/v1/mobile/commands", json(original)), gatewayEnv(newer),
    );
    expect(replay.status).toBe(200);
    expect((await replay.json() as any)).toMatchObject({
      replayed: true,
      command: { id: created.command.id, status: "applied" },
    });
  });

  it("enforces a conservative household pending-command cap", async () => {
    const gateway = makeGateway();
    await provision(gateway);
    const document = structuredClone(snapshotV2) as any;
    document.transactions = Array.from({ length: 21 }, (_, index) => ({
      ...document.transactions[0],
      id: `transaction-${index}`,
    }));
    document.counts.transactions = 21;
    const testEnv = gatewayEnv(document);
    for (let index = 0; index < 20; index += 1) {
      const response = await gateway.fetch(userRequest("/api/v1/mobile/commands", json(command({
        target_id: `transaction-${index}`,
        idempotency_key: `pending-cap-${String(index).padStart(3, "0")}`,
      }))), testEnv);
      expect(response.status).toBe(201);
    }
    await expectError(
      await gateway.fetch(userRequest("/api/v1/mobile/commands", json(command({
        target_id: "transaction-20",
        idempotency_key: "pending-cap-020",
      }))), testEnv),
      429,
      "TOO_MANY_PENDING_COMMANDS",
    );
  });

  it("rate-limits new commands without blocking idempotent retries", async () => {
    const gateway = makeGateway({ recentLimit: 1 });
    await provision(gateway);
    const document = structuredClone(snapshotV2) as any;
    document.transactions.push({ ...document.transactions[0], id: "transaction-second" });
    document.counts.transactions = 2;
    const testEnv = gatewayEnv(document);

    const first = await gateway.fetch(userRequest(
      "/api/v1/mobile/commands", json(command()),
    ), testEnv);
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;
    const replay = await gateway.fetch(userRequest(
      "/api/v1/mobile/commands", json(command()),
    ), testEnv);
    expect(replay.status).toBe(200);
    await gateway.fetch(userRequest(
      `/api/v1/mobile/commands/${firstBody.command.id}/cancel`, json({}),
    ), testEnv);

    await expectError(
      await gateway.fetch(userRequest("/api/v1/mobile/commands", json(command({
        target_id: "transaction-second",
        idempotency_key: "mobile-command-rate-02",
      }))), testEnv),
      429,
      "COMMAND_RATE_LIMITED",
    );
  });

  it("provisions members and supports bounded Mac claim and completion", async () => {
    const gateway = makeGateway();
    const provisioned = await gateway.fetch(macRequest("/api/v1/mobile/mac/members", json({
      member_id: "member-david",
      display_name: "David",
      email: "David@Example.Test",
      active: true,
    })), gatewayEnv());
    expect(provisioned.status).toBe(200);
    expect(await provisioned.text()).not.toContain("example.test");

    const created = await gateway.fetch(userRequest(
      "/api/v1/mobile/commands", json(command()),
    ), gatewayEnv());
    expect(created.status).toBe(201);

    const claimed = await gateway.fetch(macRequest(
      "/api/v1/mobile/mac/commands/claim", json({ limit: 1 }),
    ), gatewayEnv());
    expect(claimed.status).toBe(200);
    const item = (await claimed.json() as any).commands[0];
    expect(item).toMatchObject({ target_id: "transaction-fixture" });

    const completed = await gateway.fetch(macRequest(
      `/api/v1/mobile/mac/commands/${item.id}/complete`,
      json({ claim_token: item.claim_token, result: {
        status: "applied",
        category_id: "category-fun",
        subcategory_id: "subcategory-games",
        classification_revision: 1,
      } }),
    ), gatewayEnv());
    expect(completed.status).toBe(200);
    expect((await completed.json() as any).command.status).toBe("applied");
  });

  it("returns safe errors without storage or verification details", async () => {
    const verifier: AccessTokenVerifier = async () => { throw new Error("private cert detail"); };
    const gateway = createMobileGateway({ verifyAccessToken: verifier });
    const response = await gateway.fetch(userRequest("/api/v1/mobile/session"), gatewayEnv());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("private cert detail");
  });
});

function makeGateway(options: { recentLimit?: number } = {}) {
  const verifyAccessToken: AccessTokenVerifier = async (token, expected) => {
    const claims: Record<string, AccessClaims> = {
      "user-token": { aud: [USER_AUD], email: "david@example.test", sub: "user-sub" },
      "unknown-user": { aud: [USER_AUD], email: "unknown@example.test", sub: "unknown-sub" },
      "mac-token": { aud: [MAC_AUD], common_name: "fintracka-mac", sub: "mac-sub" },
    };
    const claim = claims[token];
    if (!claim || !claim.aud.includes(expected.audience)) throw new Error("invalid token");
    return claim;
  };
  return createMobileGateway({ verifyAccessToken, ...options });
}

async function provision(gateway: ReturnType<typeof makeGateway>, active = true) {
  const response = await gateway.fetch(macRequest("/api/v1/mobile/mac/members", json({
    member_id: "member-david",
    display_name: "David",
    email: "david@example.test",
    active,
  })), gatewayEnv());
  expect(response.status).toBe(200);
}

function gatewayEnv(document: unknown = snapshotV2): MobileGatewayEnv {
  return {
    COMMANDS: env.COMMANDS,
    SNAPSHOTS: new SnapshotBucket(document) as any,
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_USER_AUD: USER_AUD,
    ACCESS_MAC_AUD: MAC_AUD,
    HOUSEHOLD_ID: HOUSEHOLD,
    HOUSEHOLD_NAME: "Test household",
  };
}

class SnapshotBucket {
  private readonly bytes: Uint8Array;
  constructor(document: unknown) {
    this.bytes = new TextEncoder().encode(JSON.stringify(document));
  }
  async get(key: string) {
    if (key === "active.json") {
      return { json: async () => ({ snapshot_id: "active", digest: "digest" }) };
    }
    if (key === "snapshots/active.json") {
      return {
        customMetadata: { digest: "digest" },
        text: async () => new TextDecoder().decode(this.bytes),
        arrayBuffer: async () => this.bytes.buffer.slice(
          this.bytes.byteOffset,
          this.bytes.byteOffset + this.bytes.byteLength,
        ),
      };
    }
    return null;
  }
}

function userRequest(path: string, init?: RequestInit, token = "user-token") {
  const headers = new Headers(init?.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  headers.set("Cf-Access-Authenticated-User-Email", token === "unknown-user"
    ? "unknown@example.test"
    : "david@example.test");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function macRequest(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cf-Access-Jwt-Assertion", "mac-token");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function json(value: unknown, headers: HeadersInit = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "Sec-Fetch-Site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(value),
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    command_type: "transaction.set_classification",
    command_version: 1,
    target_id: "transaction-fixture",
    observed_revision: 0,
    category_id: "category-fun",
    subcategory_id: "subcategory-games",
    idempotency_key: "mobile-command-01",
    replace_command_id: null,
    ...overrides,
  };
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error_code: code });
}
