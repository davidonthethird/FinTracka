import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ReceiptShortcutCaptureSchema } from "../src/receiptShortcutModel";
import { ReceiptShortcutStore } from "../src/receiptShortcutStore";

declare global {
  namespace Cloudflare {
    interface Env {
      COMMANDS: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const NOW = new Date("2026-11-02T12:00:00.000Z");
const HOUSEHOLD = "shortcut-household";
const MEMBER = "shortcut-member";
const OTHER_MEMBER = "shortcut-other";

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
    env.COMMANDS.prepare("DELETE FROM household_members"),
    env.COMMANDS.prepare("DELETE FROM households"),
  ]);
  await provision();
});

describe("receipt shortcut model", () => {
  it("accepts a native Shortcuts SHA-256 idempotency key", () => {
    const nativeKey = "a".repeat(64);
    expect(ReceiptShortcutCaptureSchema.parse({
      ...capture(), idempotency_key: nativeKey,
    }).idempotency_key).toBe(nativeKey);
  });

  it("accepts ordered nonblank pages and rejects unknown, blank, duplicate, and oversized input", () => {
    expect(ReceiptShortcutCaptureSchema.parse(capture()).pages).toHaveLength(1);
    for (const invalid of [
      { ...capture(), unknown: true },
      { ...capture(), pages: [{ page_index: 0, text: " \n\t " }] },
      { ...capture(), pages: [{ page_index: 0, text: "first" }, { page_index: 0, text: "again" }] },
      { ...capture(), pages: [{ page_index: 1, text: "starts late" }] },
      { ...capture(), pages: Array.from({ length: 13 }, (_, page_index) => ({ page_index, text: "page" })) },
      { ...capture(), pages: [{ page_index: 0, text: "x".repeat(30_001) }] },
      { ...capture(), pages: Array.from({ length: 4 }, (_, page_index) => ({
        page_index, text: "x".repeat(25_001),
      })) },
      { ...capture(), idempotency_key: "not-a-uuid" },
    ]) expect(ReceiptShortcutCaptureSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("receipt shortcut store", () => {
  it("stores only the token digest and expires a session after ten minutes", async () => {
    let now = NOW;
    const store = new ReceiptShortcutStore(env.COMMANDS, () => now);
    const session = await store.createSession(HOUSEHOLD, MEMBER);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.expires_at).toBe("2026-11-02T12:10:00.000Z");
    const row = await env.COMMANDS.prepare(
      "SELECT token_digest FROM receipt_scan_sessions LIMIT 1",
    ).first<{ token_digest: string }>();
    expect(row?.token_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.token_digest).not.toContain(session.token);

    now = new Date("2026-11-02T12:10:00.001Z");
    await expect(store.createImport(session.token, capture()))
      .rejects.toMatchObject({ code: "RECEIPT_SCAN_SESSION_EXPIRED" });
  });

  it("atomically consumes a token and exactly replays only the same key and body", async () => {
    const store = makeStore();
    const session = await store.createSession(HOUSEHOLD, MEMBER);
    const first = await store.createImport(session.token, capture());
    const replay = await store.createImport(session.token, capture());
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, import: { id: first.import.id } });

    await expect(store.createImport(session.token, {
      ...capture(), idempotency_key: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "RECEIPT_SCAN_SESSION_CONSUMED" });
    await expect(store.createImport(session.token, {
      ...capture(), pages: [{ page_index: 0, text: "changed receipt" }],
    })).rejects.toMatchObject({ code: "RECEIPT_SCAN_SESSION_CONSUMED" });
  });

  it("does not let an invalid public token trigger cleanup writes", async () => {
    let now = NOW;
    const store = new ReceiptShortcutStore(env.COMMANDS, () => now);
    const session = await store.createSession(HOUSEHOLD, MEMBER);
    await store.createImport(session.token, capture());
    now = new Date("2026-11-02T12:31:00.000Z");

    await expect(store.createImport("x".repeat(43), capture()))
      .rejects.toMatchObject({ code: "RECEIPT_SCAN_SESSION_INVALID" });
    expect((await env.COMMANDS.prepare("SELECT COUNT(*) AS count FROM receipt_shortcut_imports")
      .first<{ count: number }>())?.count).toBe(1);
  });

  it("isolates imports by member and prunes them after thirty minutes", async () => {
    let now = NOW;
    const store = new ReceiptShortcutStore(env.COMMANDS, () => now);
    const session = await store.createSession(HOUSEHOLD, MEMBER);
    const created = await store.createImport(session.token, capture());
    expect((await store.getImport(HOUSEHOLD, MEMBER, created.import.id)).pages[0].text)
      .toContain("Synthetic Market");
    await expect(store.getImport(HOUSEHOLD, OTHER_MEMBER, created.import.id))
      .rejects.toMatchObject({ code: "RECEIPT_IMPORT_NOT_FOUND" });

    now = new Date("2026-11-02T12:30:00.001Z");
    await expect(store.getImport(HOUSEHOLD, MEMBER, created.import.id))
      .rejects.toMatchObject({ code: "RECEIPT_IMPORT_NOT_FOUND" });
    expect((await env.COMMANDS.prepare("SELECT COUNT(*) AS count FROM receipt_shortcut_imports")
      .first<{ count: number }>())?.count).toBe(0);
  });

  it("deletes only a member-owned import", async () => {
    const store = makeStore();
    const session = await store.createSession(HOUSEHOLD, MEMBER);
    const created = await store.createImport(session.token, capture());
    await expect(store.deleteImport(HOUSEHOLD, OTHER_MEMBER, created.import.id))
      .rejects.toMatchObject({ code: "RECEIPT_IMPORT_NOT_FOUND" });
    await store.deleteImport(HOUSEHOLD, MEMBER, created.import.id);
    await expect(store.getImport(HOUSEHOLD, MEMBER, created.import.id))
      .rejects.toMatchObject({ code: "RECEIPT_IMPORT_NOT_FOUND" });
  });

  it("requires active members and caps sessions and active imports", async () => {
    const limited = new ReceiptShortcutStore(env.COMMANDS, () => NOW, {
      hourlySessionLimit: 2, activeImportLimit: 2,
    });
    await limited.createSession(HOUSEHOLD, MEMBER);
    await limited.createSession(HOUSEHOLD, MEMBER);
    await expect(limited.createSession(HOUSEHOLD, MEMBER))
      .rejects.toMatchObject({ code: "RECEIPT_SCAN_SESSION_RATE_LIMITED" });

    const importStore = new ReceiptShortcutStore(env.COMMANDS, () => NOW, {
      hourlySessionLimit: 10, activeImportLimit: 2,
    });
    for (let index = 0; index < 2; index += 1) {
      const session = await importStore.createSession(HOUSEHOLD, OTHER_MEMBER);
      await importStore.createImport(session.token, {
        ...capture(), idempotency_key: crypto.randomUUID(),
      });
    }
    const third = await importStore.createSession(HOUSEHOLD, OTHER_MEMBER);
    await expect(importStore.createImport(third.token, {
      ...capture(), idempotency_key: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "TOO_MANY_RECEIPT_IMPORTS" });

    await env.COMMANDS.prepare("UPDATE household_members SET active = 0 WHERE id = ?")
      .bind(MEMBER).run();
    await expect(importStore.createSession(HOUSEHOLD, MEMBER))
      .rejects.toMatchObject({ code: "MEMBER_NOT_AUTHORIZED" });
  });

  it("enforces production caps across concurrent requests", async () => {
    const store = makeStore();
    const sessions = await Promise.allSettled(Array.from({ length: 11 }, () =>
      store.createSession(HOUSEHOLD, MEMBER)));
    expect(sessions.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(sessions.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await env.COMMANDS.prepare(`SELECT COUNT(*) AS count FROM receipt_scan_sessions
      WHERE actor_member_id = ?`).bind(MEMBER).first<{ count: number }>())?.count).toBe(10);

    const tokens = sessions.flatMap((result) => result.status === "fulfilled" ? [result.value.token] : []).slice(0, 6);
    const imports = await Promise.allSettled(tokens.map((token) => store.createImport(token, {
      ...capture(), idempotency_key: crypto.randomUUID(),
    })));
    expect(imports.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(imports.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await env.COMMANDS.prepare(`SELECT COUNT(*) AS count FROM receipt_shortcut_imports
      WHERE actor_member_id = ?`).bind(MEMBER).first<{ count: number }>())?.count).toBe(5);
  });
});

function makeStore() {
  return new ReceiptShortcutStore(env.COMMANDS, () => NOW);
}

function capture() {
  return {
    contract: "receipt_shortcut_capture/v1" as const,
    idempotency_key: "f3ad6254-e6ab-4a4c-bbb8-810cfde7d530",
    shortcut_version: 1 as const,
    pages: [{ page_index: 0, text: "Synthetic Market\nITEM 10.00\nTOTAL 10.00" }],
  };
}

async function provision() {
  const now = NOW.toISOString();
  await env.COMMANDS.batch([
    env.COMMANDS.prepare(
      "INSERT INTO households (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
    ).bind(HOUSEHOLD, "Shortcut household", now, now),
    ...[
      [MEMBER, "shortcut@example.test", "Shortcut member"],
      [OTHER_MEMBER, "other@example.test", "Other member"],
    ].map(([id, email, name]) => env.COMMANDS.prepare(`INSERT INTO household_members
      (id, household_id, normalized_email, display_name, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'member', 1, ?, ?)`).bind(id, HOUSEHOLD, email, name, now, now)),
  ]);
}
