import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ReceiptQueueHandoffStore } from "../src/receiptQueueHandoffStore";
import { ReceiptShortcutStore } from "../src/receiptShortcutStore";
import { ReceiptStore } from "../src/receiptStore";

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
      draftId: null,
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
    expect(first.kind).toBe("import");
    if (first.kind !== "import") throw new Error("expected a new fallback import");
    const sessionRow = await env.COMMANDS.prepare(`SELECT token_digest, body_digest
      FROM receipt_scan_sessions WHERE consumed_import_id = ?`).bind(first.import.id)
      .first<{ token_digest: string; body_digest: string }>();
    expect(sessionRow?.body_digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(shortcuts.createQueuedImport(sessionRow!.token_digest, capture()))
      .resolves.toMatchObject({ replayed: true, import: { id: first.import.id } });
    const replay = await store.complete(handoff.id, capture());
    expect(first.replayed).toBe(false);
    expect(first.import.expires_at).toBe("2026-11-18T12:31:00.000Z");
    expect(replay).toEqual({ kind: "verified", replayed: true,
      importId: first.import.id, draftId: null });
    await expect(store.get(HOUSEHOLD, MEMBER, handoff.id)).resolves.toMatchObject({
      status: "completed", importId: first.import.id, errorCode: null,
    });

    await expect(store.complete(handoff.id, {
      ...capture(), text: "changed\nTOTAL 11.00",
    })).rejects.toMatchObject({ code: "RECEIPT_QUEUE_HANDOFF_CHANGED" });
    expect((await env.COMMANDS.prepare("SELECT COUNT(*) AS count FROM receipt_shortcut_imports")
      .first<{ count: number }>())?.count).toBe(1);
  });

  it("publishes one reviewable import, links one household draft, and starts verification", async () => {
    const shortcuts = new ReceiptShortcutStore(env.COMMANDS, () => NOW);
    const session = await shortcuts.createSession(HOUSEHOLD, MEMBER);
    const store = makeStore();
    const handoff = await store.create(HOUSEHOLD, MEMBER, session.token);
    const imported = await shortcuts.createImport(session.token, capture());
    const sessionRow = await env.COMMANDS.prepare(`SELECT token_digest, body_digest
      FROM receipt_scan_sessions WHERE consumed_import_id = ?`).bind(imported.import.id)
      .first<{ token_digest: string; body_digest: string }>();

    const reviewable = await store.markReviewableBySession(
      sessionRow!.token_digest, imported.import.id, sessionRow!.body_digest,
    );
    const replay = await store.markReviewableBySession(
      sessionRow!.token_digest, imported.import.id, sessionRow!.body_digest,
    );
    expect(reviewable).toMatchObject({
      id: handoff.id, status: "reviewable", importId: imported.import.id, draftId: null,
    });
    expect(replay).toEqual(reviewable);
    await expect(store.listActiveIds()).resolves.toEqual(new Set([handoff.id]));

    const receipt = await new ReceiptStore(env.COMMANDS, () => NOW).create(HOUSEHOLD, MEMBER, {
      idempotency_key: "queue-link-draft",
      draft: receiptDraft(),
    });
    const linked = await store.linkDraft(HOUSEHOLD, MEMBER, imported.import.id, receipt.draft.id);
    expect(linked).toMatchObject({ status: "reviewable", draftId: receipt.draft.id });
    await expect(store.linkDraft(HOUSEHOLD, MEMBER, imported.import.id, receipt.draft.id))
      .resolves.toEqual(linked);
    await expect(store.start(handoff.id)).resolves.toMatchObject({
      status: "processing", importId: imported.import.id, draftId: receipt.draft.id,
    });
    const completed = await store.complete(handoff.id, capture());
    expect(completed).toMatchObject({ kind: "verified", replayed: false,
      importId: imported.import.id, draftId: receipt.draft.id });
    await expect(store.get(HOUSEHOLD, MEMBER, handoff.id)).resolves.toMatchObject({
      status: "completed", importId: imported.import.id, draftId: receipt.draft.id,
    });
    await expect(new ReceiptStore(env.COMMANDS, () => NOW).get(HOUSEHOLD, receipt.draft.id))
      .resolves.toMatchObject({ lines: [{ owner: "Shared" }] });
    expect((await env.COMMANDS.prepare("SELECT COUNT(*) AS count FROM receipt_shortcut_imports")
      .first<{ count: number }>())?.count).toBe(1);
  });

  it("publishes the direct import even when Mac verification starts first", async () => {
    const shortcuts = new ReceiptShortcutStore(env.COMMANDS, () => NOW);
    const session = await shortcuts.createSession(HOUSEHOLD, MEMBER);
    const store = makeStore();
    const handoff = await store.create(HOUSEHOLD, MEMBER, session.token);
    await store.start(handoff.id);
    const imported = await shortcuts.createImport(session.token, capture());
    const sessionRow = await env.COMMANDS.prepare(`SELECT token_digest, body_digest
      FROM receipt_scan_sessions WHERE consumed_import_id = ?`).bind(imported.import.id)
      .first<{ token_digest: string; body_digest: string }>();

    await expect(store.markReviewableBySession(
      sessionRow!.token_digest, imported.import.id, sessionRow!.body_digest,
    )).resolves.toMatchObject({ status: "reviewable", importId: imported.import.id });
    await expect(store.complete(handoff.id, capture())).resolves.toMatchObject({
      kind: "verified", replayed: false, importId: imported.import.id,
    });
  });

  it("fails a changed provisional capture without replacing its import or linked draft", async () => {
    const shortcuts = new ReceiptShortcutStore(env.COMMANDS, () => NOW);
    const session = await shortcuts.createSession(HOUSEHOLD, MEMBER);
    const store = makeStore();
    const handoff = await store.create(HOUSEHOLD, MEMBER, session.token);
    const imported = await shortcuts.createImport(session.token, capture());
    const sessionRow = await env.COMMANDS.prepare(`SELECT token_digest, body_digest
      FROM receipt_scan_sessions WHERE consumed_import_id = ?`).bind(imported.import.id)
      .first<{ token_digest: string; body_digest: string }>();
    await store.markReviewableBySession(
      sessionRow!.token_digest, imported.import.id, sessionRow!.body_digest,
    );
    const receipt = await new ReceiptStore(env.COMMANDS, () => NOW).create(HOUSEHOLD, MEMBER, {
      idempotency_key: "queue-mismatch-draft", draft: receiptDraft(),
    });
    await store.linkDraft(HOUSEHOLD, MEMBER, imported.import.id, receipt.draft.id);

    await expect(store.complete(handoff.id, { ...capture(), text: "CHANGED\nTOTAL 10.00" }))
      .rejects.toMatchObject({ code: "CAPTURE_MISMATCH" });
    await expect(store.get(HOUSEHOLD, MEMBER, handoff.id)).resolves.toMatchObject({
      status: "failed", errorCode: "CAPTURE_MISMATCH", importId: imported.import.id,
      draftId: receipt.draft.id,
    });
    expect((await env.COMMANDS.prepare("SELECT COUNT(*) AS count FROM receipt_shortcut_imports")
      .first<{ count: number }>())?.count).toBe(1);
  });

  it("fails closed when a reviewable import, digest, member, or draft changes", async () => {
    const shortcuts = new ReceiptShortcutStore(env.COMMANDS, () => NOW);
    const session = await shortcuts.createSession(HOUSEHOLD, MEMBER);
    const store = makeStore();
    await store.create(HOUSEHOLD, MEMBER, session.token);
    const imported = await shortcuts.createImport(session.token, capture());
    const row = await env.COMMANDS.prepare(`SELECT token_digest, body_digest
      FROM receipt_scan_sessions WHERE consumed_import_id = ?`).bind(imported.import.id)
      .first<{ token_digest: string; body_digest: string }>();
    await store.markReviewableBySession(row!.token_digest, imported.import.id, row!.body_digest);

    await expect(store.markReviewableBySession(row!.token_digest, crypto.randomUUID(), row!.body_digest))
      .rejects.toMatchObject({ code: "RECEIPT_QUEUE_HANDOFF_CHANGED" });
    await expect(store.markReviewableBySession(row!.token_digest, imported.import.id, "f".repeat(64)))
      .rejects.toMatchObject({ code: "RECEIPT_QUEUE_HANDOFF_CHANGED" });
    await expect(store.linkDraft(HOUSEHOLD, OTHER_MEMBER, imported.import.id, crypto.randomUUID()))
      .rejects.toMatchObject({ code: "RECEIPT_QUEUE_HANDOFF_NOT_FOUND" });
    const otherDraft = await new ReceiptStore(env.COMMANDS, () => NOW).create(
      HOUSEHOLD, OTHER_MEMBER, { idempotency_key: "other-member-draft", draft: receiptDraft() },
    );
    await expect(store.linkDraft(HOUSEHOLD, MEMBER, imported.import.id, otherDraft.draft.id))
      .rejects.toMatchObject({ code: "RECEIPT_DRAFT_NOT_FOUND" });
    await expect(store.linkDraft(HOUSEHOLD, MEMBER, imported.import.id, crypto.randomUUID()))
      .rejects.toMatchObject({ code: "RECEIPT_DRAFT_NOT_FOUND" });
  });

  it("keeps terminal handoffs recoverable until the Mac confirms local cleanup", async () => {
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
    await expect(store.start(handoff.id)).resolves.toMatchObject({
      status: "failed", errorCode: "INVALID_PACKAGE",
    });
    await expect(store.complete(handoff.id, capture()))
      .rejects.toMatchObject({ code: "RECEIPT_QUEUE_HANDOFF_FINISHED" });
  });

  it("lets the Mac confirm a completion whose HTTP response was lost", async () => {
    const shortcuts = new ReceiptShortcutStore(env.COMMANDS, () => NOW);
    const session = await shortcuts.createSession(HOUSEHOLD, MEMBER);
    const store = makeStore();
    const handoff = await store.create(HOUSEHOLD, MEMBER, session.token);

    await store.start(handoff.id);
    await store.complete(handoff.id, capture());

    await expect(store.listActiveIds()).resolves.toEqual(new Set());
    await expect(store.start(handoff.id)).resolves.toMatchObject({
      status: "completed", importId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
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

function receiptDraft() {
  return {
    contract: "receipt_draft/v1" as const, status: "editing" as const,
    merchant: "Synthetic Market", purchase_date: "2026-11-11", currency: "USD",
    masked_payment_hint: null, page_count: 1, subtotal_minor: 1000, discount_minor: 0,
    tax_minor: 0, tip_minor: 0, fees_minor: 0, total_minor: 1000,
    lines: [{ id: "line-1", order: 0, source_page: 0, description: "ITEM", quantity: "1",
      unit_amount_minor: 1000, item_total_minor: 1000, line_discount_minor: 0,
      tax_minor: 0, tip_minor: 0, fees_minor: 0, taxable: true, owner: "Shared" as const,
      category_id: null, subcategory_id: null, confidence_basis_points: 9000, review_flags: [] }],
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
