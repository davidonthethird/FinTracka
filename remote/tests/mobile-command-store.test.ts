import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalClassificationPayload,
  sha256Hex,
  type CreateClassificationCommand,
} from "../src/mobileCommandModel";
import { MobileCommandStore } from "../src/mobileCommandStore";

declare global {
  namespace Cloudflare {
    interface Env {
      COMMANDS: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const HOUSEHOLD = "household-test";
const MEMBER = "member-david";
const OTHER_MEMBER = "member-ariela";
const NOW = new Date("2026-10-30T12:00:00.000Z");

beforeAll(async () => {
  await applyD1Migrations(env.COMMANDS, env.TEST_MIGRATIONS);
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

describe("mobile command store", () => {
  it("keeps the v1 digest stable and binds v2 scope into its digest", async () => {
    const v1 = canonicalClassificationPayload(1, "category-fun", null, "one_time");
    const past = canonicalClassificationPayload(2, "category-fun", null, "past_and_future");
    const future = canonicalClassificationPayload(2, "category-fun", null, "future");

    expect(v1).toBe('{"category_id":"category-fun","subcategory_id":null}');
    expect(past).toBe('{"category_id":"category-fun","subcategory_id":null,"scope":"past_and_future"}');
    expect(await sha256Hex(past)).not.toBe(await sha256Hex(future));
  });

  it("normalizes v1 as one-time and carries v2 scope through create and claim", async () => {
    const store = makeStore();
    await provision(store);
    const v1 = await store.createOrReplace(HOUSEHOLD, MEMBER, command("version-one-0001", "transaction-1"));
    expect(v1.command).toMatchObject({ command_version: 1, scope: "one_time" });
    await store.cancel(HOUSEHOLD, v1.command.id, MEMBER);

    const v2 = await store.createOrReplace(HOUSEHOLD, MEMBER, {
      ...command("version-two-0001", "transaction-2"),
      command_version: 2,
      scope: "past_and_future",
    } as CreateClassificationCommand);
    expect(v2.command).toMatchObject({ command_version: 2, scope: "past_and_future" });
    expect(await store.claim("processor-1", 1)).toMatchObject([
      { id: v2.command.id, command_version: 2, scope: "past_and_future" },
    ]);
    expect(JSON.stringify(v2.command)).not.toMatch(/merchant|description|amount_minor|account_name/);
  });

  it("provisions and resolves one active member by normalized email", async () => {
    const store = makeStore();
    await provision(store);

    expect(await store.resolveMember("  DAVID@EXAMPLE.TEST ")).toMatchObject({
      id: MEMBER,
      household_id: HOUSEHOLD,
      display_name: "David",
    });
    await store.upsertMember({
      householdId: HOUSEHOLD,
      householdName: "Test household",
      memberId: MEMBER,
      displayName: "David updated",
      normalizedEmail: "david@example.test",
      active: false,
    });
    expect(await store.resolveMember("david@example.test")).toBeNull();
  });

  it("replays an identical idempotency key and rejects changed content", async () => {
    const store = makeStore();
    await provision(store);
    const input = command("idempotency-0001", "transaction-1");

    const first = await store.createOrReplace(HOUSEHOLD, MEMBER, input);
    const replay = await store.createOrReplace(HOUSEHOLD, MEMBER, input);

    expect(replay.replayed).toBe(true);
    expect(replay.command.id).toBe(first.command.id);
    await expect(store.createOrReplace(HOUSEHOLD, MEMBER, {
      ...input,
      category_id: "category-other",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("allows only one active command per target and replaces pending work explicitly", async () => {
    const store = makeStore();
    await provision(store);
    const first = await store.createOrReplace(
      HOUSEHOLD, MEMBER, command("active-command-01", "transaction-1"),
    );

    await expect(store.createOrReplace(
      HOUSEHOLD, OTHER_MEMBER, command("active-command-02", "transaction-1"),
    )).rejects.toMatchObject({ code: "ACTIVE_COMMAND_EXISTS" });

    const replacement = await store.createOrReplace(
      HOUSEHOLD,
      OTHER_MEMBER,
      { ...command("active-command-03", "transaction-1"), replace_command_id: first.command.id },
    );
    expect(replacement.command.supersedes_command_id).toBe(first.command.id);
    const rows = await store.listVisible(HOUSEHOLD, 10);
    expect(rows.map((row) => row.status)).toEqual(["pending", "superseded"]);
  });

  it("cancels only pending commands and claims oldest work in bounded batches", async () => {
    let now = NOW;
    const store = new MobileCommandStore(env.COMMANDS, () => now);
    await provision(store);
    const first = await store.createOrReplace(
      HOUSEHOLD, MEMBER, command("claim-command-01", "transaction-1"),
    );
    now = new Date(NOW.getTime() + 1_000);
    const second = await store.createOrReplace(
      HOUSEHOLD, MEMBER, command("claim-command-02", "transaction-2"),
    );

    const claimed = await store.claim("processor-1", 1);
    expect(claimed.map((item) => item.id)).toEqual([first.command.id]);
    await expect(store.cancel(HOUSEHOLD, first.command.id, MEMBER))
      .rejects.toMatchObject({ code: "COMMAND_NOT_CANCELLABLE" });
    expect((await store.cancel(HOUSEHOLD, second.command.id, MEMBER)).status).toBe("cancelled");
  });

  it("recovers expired leases and requires the current token for idempotent completion", async () => {
    let now = NOW;
    const store = new MobileCommandStore(env.COMMANDS, () => now);
    await provision(store);
    const created = await store.createOrReplace(
      HOUSEHOLD, MEMBER, command("lease-command-001", "transaction-1"),
    );
    const [firstClaim] = await store.claim("processor-1", 1);

    await expect(store.complete(created.command.id, "wrong-token", {
      status: "applied", category_id: "category-fun", subcategory_id: null,
      classification_revision: 1,
    })).rejects.toMatchObject({ code: "STALE_CLAIM" });

    now = new Date(NOW.getTime() + 6 * 60_000);
    await store.expireAndPrune();
    const [secondClaim] = await store.claim("processor-2", 1);
    expect(secondClaim.id).toBe(firstClaim.id);
    expect(secondClaim.claim_token).not.toBe(firstClaim.claim_token);

    const result = {
      status: "applied" as const,
      category_id: "category-fun",
      subcategory_id: null,
      classification_revision: 1,
    };
    expect((await store.complete(secondClaim.id, secondClaim.claim_token, result)).status)
      .toBe("applied");
    expect((await store.complete(secondClaim.id, secondClaim.claim_token, result)).status)
      .toBe("applied");
    await expect(store.complete(secondClaim.id, secondClaim.claim_token, {
      ...result, classification_revision: 2,
    })).rejects.toMatchObject({ code: "COMPLETION_CONFLICT" });
  });

  it("expires pending work after thirty days and prunes terminal history after ninety", async () => {
    let now = NOW;
    const store = new MobileCommandStore(env.COMMANDS, () => now);
    await provision(store);
    const created = await store.createOrReplace(
      HOUSEHOLD, MEMBER, command("expiry-command-01", "transaction-1"),
    );

    now = new Date(NOW.getTime() + 31 * 86_400_000);
    const expired = await store.expireAndPrune();
    expect(expired.expired).toBe(1);
    expect((await store.listVisible(HOUSEHOLD, 10))[0].status).toBe("expired");
    expect(await eventTypes(created.command.id)).toContain("expired");

    now = new Date(NOW.getTime() + 122 * 86_400_000);
    const pruned = await store.expireAndPrune();
    expect(pruned.pruned).toBe(1);
    expect(await store.listVisible(HOUSEHOLD, 10)).toEqual([]);
  });

  it("cleans expired work on browser-visible reads even when no Mac claims", async () => {
    let now = NOW;
    const store = new MobileCommandStore(env.COMMANDS, () => now);
    await provision(store);
    await store.createOrReplace(
      HOUSEHOLD, MEMBER, command("browser-expiry-01", "transaction-1"),
    );

    now = new Date(NOW.getTime() + 31 * 86_400_000);
    expect((await store.listVisible(HOUSEHOLD, 10))[0].status).toBe("expired");
  });

  it("keeps active work visible ahead of a full page of newer terminal history", async () => {
    const store = makeStore();
    await provision(store);
    const active = await store.createOrReplace(
      HOUSEHOLD, MEMBER, command("old-active-001", "transaction-active"),
    );
    await env.COMMANDS.batch(Array.from({ length: 100 }, (_, index) => {
      const time = new Date(NOW.getTime() + (index + 1) * 1_000).toISOString();
      return env.COMMANDS.prepare(`
        INSERT INTO mobile_commands
          (id, household_id, actor_member_id, command_type, command_version,
           target_type, target_id, observed_revision, payload_json, payload_digest,
           idempotency_key, status, error_code, created_at, updated_at, expires_at, finished_at)
        VALUES (?, ?, ?, 'transaction.set_classification', 1, 'transaction', ?, 0,
                ?, ?, ?, 'rejected', 'FIXTURE_REJECTED', ?, ?, ?, ?)
      `).bind(
        `terminal-${index}`, HOUSEHOLD, MEMBER, `terminal-target-${index}`,
        '{"category_id":"category-fun","subcategory_id":null}', "a".repeat(64),
        `new-terminal-${String(index).padStart(3, "0")}`, time, time,
        new Date(NOW.getTime() + 31 * 86_400_000).toISOString(), time,
      );
    }));

    expect((await store.listVisible(HOUSEHOLD, 100)).some(
      (item) => item.id === active.command.id && item.status === "pending",
    )).toBe(true);
  });

  it("enforces payload and state constraints in D1", async () => {
    const store = makeStore();
    await provision(store);
    await expect(env.COMMANDS.prepare(`
      INSERT INTO mobile_commands
        (id, household_id, actor_member_id, command_type, command_version,
         target_type, target_id, observed_revision, payload_json, payload_digest,
         idempotency_key, status, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, 'transaction.set_classification', 1, 'transaction', ?, 0,
              ?, ?, ?, 'invalid', ?, ?, ?)
    `).bind(
      "bad-command", HOUSEHOLD, MEMBER, "transaction-1", "{}", "a".repeat(64),
      "bad-command-key", NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    ).run()).rejects.toThrow();
  });

  it("rejects a member from a different household", async () => {
    const store = makeStore();
    await provision(store);
    await store.upsertMember({
      householdId: "other-household",
      householdName: "Other household",
      memberId: "other-member",
      displayName: "Other",
      normalizedEmail: "other@example.test",
      active: true,
    });

    await expect(store.createOrReplace(
      HOUSEHOLD,
      "other-member",
      command("cross-household-01", "transaction-1"),
    )).rejects.toMatchObject({ code: "MEMBER_NOT_AUTHORIZED" });
  });
});

function makeStore(): MobileCommandStore {
  return new MobileCommandStore(env.COMMANDS, () => NOW);
}

async function provision(store: MobileCommandStore): Promise<void> {
  await store.upsertMember({
    householdId: HOUSEHOLD,
    householdName: "Test household",
    memberId: MEMBER,
    displayName: "David",
    normalizedEmail: "david@example.test",
    active: true,
  });
  await store.upsertMember({
    householdId: HOUSEHOLD,
    householdName: "Test household",
    memberId: OTHER_MEMBER,
    displayName: "Ariela",
    normalizedEmail: "ariela@example.test",
    active: true,
  });
}

function command(idempotencyKey: string, targetId: string): CreateClassificationCommand {
  return {
    command_type: "transaction.set_classification",
    command_version: 1,
    target_id: targetId,
    observed_revision: 0,
    category_id: "category-fun",
    subcategory_id: null,
    idempotency_key: idempotencyKey,
    replace_command_id: null,
  };
}

async function eventTypes(commandId: string): Promise<string[]> {
  const result = await env.COMMANDS.prepare(
    "SELECT event_type FROM command_events WHERE command_id = ? ORDER BY occurred_at, id",
  ).bind(commandId).all<{ event_type: string }>();
  return result.results.map((row) => row.event_type);
}

