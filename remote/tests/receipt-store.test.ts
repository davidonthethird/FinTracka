import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ReceiptStore } from "../src/receiptStore";
import { draft } from "./receipt-model.test";

declare global {
  namespace Cloudflare {
    interface Env {
      COMMANDS: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const NOW = new Date("2026-11-01T12:00:00.000Z");
const HOUSEHOLD = "receipt-household";
const MEMBER = "receipt-member";

beforeAll(async () => {
  await applyD1Migrations(env.COMMANDS, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.COMMANDS, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.COMMANDS.batch([
    env.COMMANDS.prepare("DELETE FROM receipt_events"),
    env.COMMANDS.prepare("DELETE FROM receipt_lines"),
    env.COMMANDS.prepare("DELETE FROM receipt_revisions"),
    env.COMMANDS.prepare("DELETE FROM receipt_drafts"),
    env.COMMANDS.prepare("DELETE FROM household_members"),
    env.COMMANDS.prepare("DELETE FROM households"),
  ]);
  await provision();
});

describe("receipt store", () => {
  it("creates one immutable revision and exactly replays an idempotency key", async () => {
    const store = makeStore();
    const first = await store.create(HOUSEHOLD, MEMBER, {
      idempotency_key: "receipt-create-0001",
      draft: draft(),
    });
    const replay = await store.create(HOUSEHOLD, MEMBER, {
      idempotency_key: "receipt-create-0001",
      draft: draft(),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.draft.id).toBe(first.draft.id);
    expect((await store.getImmutableRevision(HOUSEHOLD, first.draft.id, 1)).digest)
      .toBe(first.draft.digest);
    await expect(store.create(HOUSEHOLD, MEMBER, {
      idempotency_key: "receipt-create-0001",
      draft: { ...draft(), merchant: "Changed" },
    })).rejects.toMatchObject({ code: "RECEIPT_IDEMPOTENCY_CONFLICT" });
  });

  it("replaces atomically, rejects stale revisions, and preserves prior immutable bodies", async () => {
    const store = makeStore();
    const created = await store.create(HOUSEHOLD, MEMBER, {
      idempotency_key: "receipt-create-0002", draft: draft(),
    });
    const replaced = await store.replace(HOUSEHOLD, MEMBER, created.draft.id, {
      expected_revision: 1,
      idempotency_key: "receipt-update-0002",
      draft: { ...draft(), merchant: "Corrected Market" },
    });
    expect(replaced.draft).toMatchObject({ revision: 2, merchant: "Corrected Market" });
    expect((await store.getImmutableRevision(HOUSEHOLD, created.draft.id, 1)).draft.merchant)
      .toBe("Synthetic Market");
    await expect(store.replace(HOUSEHOLD, MEMBER, created.draft.id, {
      expected_revision: 1,
      idempotency_key: "receipt-update-stale",
      draft: draft(),
    })).rejects.toMatchObject({ code: "RECEIPT_REVISION_CONFLICT" });
  });

  it("scopes reads to a household, dismisses an unmatched draft, and prunes inactive drafts", async () => {
    let now = NOW;
    const store = new ReceiptStore(env.COMMANDS, () => now);
    const created = await store.create(HOUSEHOLD, MEMBER, {
      idempotency_key: "receipt-create-0003", draft: draft(),
    });
    await expect(store.get("other-household", created.draft.id))
      .rejects.toMatchObject({ code: "RECEIPT_NOT_FOUND" });
    expect((await store.dismiss(HOUSEHOLD, MEMBER, created.draft.id, 1)).status).toBe("dismissed");
    now = new Date(NOW.getTime() + 91 * 86_400_000);
    expect((await store.expireAndPrune()).pruned).toBe(1);
    await expect(store.get(HOUSEHOLD, created.draft.id))
      .rejects.toMatchObject({ code: "RECEIPT_NOT_FOUND" });
  });

  it("enforces active draft and member write bounds", async () => {
    const store = new ReceiptStore(env.COMMANDS, () => NOW, { activeLimit: 2, hourlyWriteLimit: 2 });
    await store.create(HOUSEHOLD, MEMBER, { idempotency_key: "receipt-bound-001", draft: draft() });
    await store.create(HOUSEHOLD, MEMBER, { idempotency_key: "receipt-bound-002", draft: draft() });
    await expect(store.create(HOUSEHOLD, MEMBER, {
      idempotency_key: "receipt-bound-003", draft: draft(),
    })).rejects.toMatchObject({ code: "RECEIPT_WRITE_RATE_LIMITED" });
  });
});

function makeStore() {
  return new ReceiptStore(env.COMMANDS, () => NOW);
}

async function provision() {
  const now = NOW.toISOString();
  await env.COMMANDS.batch([
    env.COMMANDS.prepare("INSERT INTO households (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
      .bind(HOUSEHOLD, "Receipt household", now, now),
    env.COMMANDS.prepare(`INSERT INTO household_members
      (id, household_id, normalized_email, display_name, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'member', 1, ?, ?)`)
      .bind(MEMBER, HOUSEHOLD, "receipt@example.test", "Receipt member", now, now),
  ]);
}
