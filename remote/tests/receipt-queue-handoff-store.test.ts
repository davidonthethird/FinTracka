import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ReceiptQueueHandoffStore } from "../src/receiptQueueHandoffStore";
import { ReceiptShortcutStore } from "../src/receiptShortcutStore";

declare global {
  namespace Cloudflare {
    interface Env {
      COMMANDS: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const NOW = new Date("2026-11-11T12:00:00.000Z");
const HOUSEHOLD = "queue-household";
const MEMBER = "queue-member";
const OTHER_MEMBER = "queue-other";

beforeAll(async () => {
  await applyD1Migrations(env.COMMANDS, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.COMMANDS.batch([
    env.COMMANDS.prepare("DELETE FROM receipt_queue_handoffs"),
    env.COMMANDS.prepare("DELETE FROM receipt_shortcut_imports"),
    env.COMMANDS.prepare("DELETE FROM receipt_scan_sessions"),
    env.COMMANDS.prepare("DELETE FROM receipt_events"),
    env.COMMANDS.prepare("DELETE FROM receipt_lines"),
    env.COMMANDS.prepare("DELETE FROM receipt_revisions"),
    env.COMMANDS.prepare("DELETE FROM receipt_drafts"),
    env.COMMANDS.prepare("DELETE FROM household_members"),
    env.COMMANDS.prepare("DELETE FROM households"),
  ]);
  await provision();
});

describe("receipt queue handoff store", () => {
  it("creates one opaque seven-day handoff for a member-owned scan session", async () => {
    const shortcuts = new ReceiptShortcutStore(env.COMMANDS, () => NOW);
    const session = await shortcuts.createSession(HOUSEHOLD, MEMBER);
    const store = makeStore();

    const created = await store.create(HOUSEHOLD, MEMBER, session.token);
    const replay = await store.create(HOUSEHOLD, MEMBER, session.token);

    expect(created).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: "pending",
      importId: null,
      errorCode: null,
      createdAt: "2026-11-11T12:00:00.000Z",
      expiresAt: "2026-11-18T12:00:00.000Z",
    });
    expect(replay).toEqual(created);
    await expect(store.listForMember(HOUSEHOLD, MEMBER)).resolves.toEqual([created]);
    await expect(store.listForMember(HOUSEHOLD, OTHER_MEMBER)).resolves.toEqual([]);
    await expect(store.listActiveIds()).resolves.toEqual(new Set([created.id]));
  });

  it("rejects sessions owned by another member and unknown sessions", async () => {
    const shortcuts = new ReceiptShortcutStore(env.COMMANDS, () => NOW);
    const session = await shortcuts.createSession(HOUSEHOLD, MEMBER);
    const store = makeStore();

    await expect(store.create(HOUSEHOLD, OTHER_MEMBER, session.token))
      .rejects.toMatchObject({ code: "RECEIPT_SCAN_SESSION_INVALID" });
    await expect(store.create(HOUSEHOLD, MEMBER, "x".repeat(43)))
      .rejects.toMatchObject({ code: "RECEIPT_SCAN_SESSION_INVALID" });
    await expect(store.get(HOUSEHOLD, MEMBER, crypto.randomUUID()))
      .rejects.toMatchObject({ code: "RECEIPT_QUEUE_HANDOFF_NOT_FOUND" });
  });

  it("expires handoffs after seven days and bounds the active-id request", async () => {
    let now = NOW;
    const shortcuts = new ReceiptShortcutStore(env.COMMANDS, () => now);
    const session = await shortcuts.createSession(HOUSEHOLD, MEMBER);
    const store = new ReceiptQueueHandoffStore(env.COMMANDS, () => now);
    const created = await store.create(HOUSEHOLD, MEMBER, session.token);

    expect(() => store.listActiveIds(101)).toThrowError("receipt queue handoff limit must be between 1 and 100");
    now = new Date("2026-11-18T12:00:00.001Z");
    await expect(store.listActiveIds()).resolves.toEqual(new Set());
    await expect(store.get(HOUSEHOLD, MEMBER, created.id))
      .rejects.toMatchObject({ code: "RECEIPT_QUEUE_HANDOFF_EXPIRED" });
  });

  it("completes after the public token expires and exactly replays only the same capture", async () => {
    let now = NOW;
    const shortcuts = new ReceiptShortcutStore(env.COMMANDS, () => now);
    const session = await shortcuts.createSession(HOUSEHOLD, MEMBER);
    const store = new ReceiptQueueHandoffStore(env.COMMANDS, () => now);
    const handoff = await store.create(HOUSEHOLD, MEMBER, session.token);

    now = new Date("2026-11-11T12:31:00.000Z");
    await expect(shortcuts.createImport(session.token, capture()))
      .rejects.toMatchObject({ code: "RECEIPT_SCAN_SESSION_EXPIRED" });

    const first = await store.complete(handoff.id, capture());
    const sessionRow = await env.COMMANDS.prepare(`SELECT token_digest, body_digest
      FROM receipt_scan_sessions WHERE consumed_import_id = ?`).bind(first.import.id)
      .first<{ token_digest: string; body_digest: string }>();
    expect(sessionRow?.body_digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(shortcuts.createQueuedImport(sessionRow!.token_digest, capture()))
      .resolves.toMatchObject({ replayed: true, import: { id: first.import.id } });
    const replay = await store.complete(handoff.id, capture());
    expect(first.replayed).toBe(false);
    expect(first.import.expires_at).toBe("2026-11-18T12:31:00.000Z");
    expect(replay).toMatchObject({ replayed: true, import: { id: first.import.id } });
    await expect(store.get(HOUSEHOLD, MEMBER, handoff.id)).resolves.toMatchObject({
      status: "completed", importId: first.import.id, errorCode: null,
    });

    await expect(store.complete(handoff.id, {
      ...capture(), text: "changed\nTOTAL 11.00",
    })).rejects.toMatchObject({ code: "RECEIPT_QUEUE_HANDOFF_CHANGED" });
    expect((await env.COMMANDS.prepare("SELECT COUNT(*) AS count FROM receipt_shortcut_imports")
      .first<{ count: number }>())?.count).toBe(1);
  });

  it("records Mac processing and terminal failure without leaving the handoff active", async () => {
    const shortcuts = new ReceiptShortcutStore(env.COMMANDS, () => NOW);
    const session = await shortcuts.createSession(HOUSEHOLD, MEMBER);
    const store = makeStore();
    const handoff = await store.create(HOUSEHOLD, MEMBER, session.token);

    await expect(store.start(handoff.id)).resolves.toMatchObject({ status: "processing" });
    await expect(store.start(handoff.id)).resolves.toMatchObject({ status: "processing" });
    await expect(store.fail(handoff.id, "INVALID_PACKAGE")).resolves.toMatchObject({
      status: "failed", errorCode: "INVALID_PACKAGE",
    });
    await expect(store.fail(handoff.id, "INVALID_PACKAGE")).resolves.toMatchObject({
      status: "failed", errorCode: "INVALID_PACKAGE",
    });
    await expect(store.listActiveIds()).resolves.toEqual(new Set());
    await expect(store.complete(handoff.id, capture()))
      .rejects.toMatchObject({ code: "RECEIPT_QUEUE_HANDOFF_FINISHED" });
  });
});

function makeStore() {
  return new ReceiptQueueHandoffStore(env.COMMANDS, () => NOW);
}

function capture() {
  const result = JSON.stringify({
    merchant: { value: "Synthetic Market", evidence: "Synthetic Market" },
    date: null,
    subtotal: null,
    discounts: [],
    tax: null,
    tip: null,
    fees: [],
    total: { value_cents: 1000, evidence: "10.00" },
    lines: [{ description: "ITEM", amount_cents: 1000,
      description_evidence: "ITEM", amount_evidence: "10.00" }],
  });
  return {
    contract: "receipt_shortcut_capture/v3" as const,
    idempotency_key: "d".repeat(64),
    shortcut_version: 3 as const,
    text: "Synthetic Market\nITEM 10.00\nTOTAL 10.00",
    runs: [
      { model: "on_device" as const, status: "completed" as const,
        duration_ms: 1_000, model_result: result },
      { model: "private_cloud_compute" as const, status: "completed" as const,
        duration_ms: 900, model_result: result },
    ],
  };
}

async function provision() {
  const now = NOW.toISOString();
  await env.COMMANDS.batch([
    env.COMMANDS.prepare(
      "INSERT INTO households (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
    ).bind(HOUSEHOLD, "Queue household", now, now),
    ...[
      [MEMBER, "queue@example.test", "Queue member"],
      [OTHER_MEMBER, "other@example.test", "Other member"],
    ].map(([id, email, name]) => env.COMMANDS.prepare(`INSERT INTO household_members
      (id, household_id, normalized_email, display_name, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'member', 1, ?, ?)`).bind(id, HOUSEHOLD, email, name, now, now)),
  ]);
}
