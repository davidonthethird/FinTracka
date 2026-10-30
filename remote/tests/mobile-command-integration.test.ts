import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MobileCommandStore } from "../src/mobileCommandStore";

declare global {
  namespace Cloudflare {
    interface Env { COMMANDS: D1Database; TEST_MIGRATIONS: D1Migration[]; }
  }
}

const household = "integration-household";
const member = "integration-member";

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

describe("mobile command integration boundary", () => {
  it("moves a privacy-minimized proposal through create, claim, completion, and retention", async () => {
    const store = new MobileCommandStore(env.COMMANDS, () => new Date("2026-10-30T12:00:00Z"));
    await store.upsertMember({
      householdId: household, householdName: "Fixture household", memberId: member,
      displayName: "Fixture member", normalizedEmail: "member@example.test", active: true,
    });
    const created = await store.createOrReplace(household, member, {
      command_type: "transaction.set_classification", command_version: 1,
      target_id: "canonical-transaction", observed_revision: 2,
      category_id: "category-groceries", subcategory_id: "subcategory-market",
      idempotency_key: "integration-key-0001", replace_command_id: null,
    });
    const [claimed] = await store.claim("processor-integration", 1);
    expect(claimed.id).toBe(created.command.id);
    await store.complete(claimed.id, claimed.claim_token, {
      status: "applied", category_id: "category-groceries",
      subcategory_id: "subcategory-market", classification_revision: 3,
    });
    expect((await store.listVisible(household, 10))[0]).toMatchObject({ status: "applied", result: { classification_revision: 3 } });

    const columns = await env.COMMANDS.prepare("PRAGMA table_info(mobile_commands)").all<{ name: string }>();
    expect(columns.results.map((row) => row.name)).not.toEqual(expect.arrayContaining([
      "merchant", "amount_minor", "account_name", "institution_name", "description",
    ]));
  });
});
