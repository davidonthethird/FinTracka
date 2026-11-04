import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ReceiptRefinementStore } from "../src/receiptRefinementStore";

declare global { namespace Cloudflare { interface Env { COMMANDS: D1Database; TEST_MIGRATIONS: D1Migration[] } } }

const NOW = new Date("2026-11-04T12:00:00.000Z");

beforeAll(async () => { await applyD1Migrations(env.COMMANDS, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.COMMANDS.batch([
    env.COMMANDS.prepare("DELETE FROM receipt_refinements"),
    env.COMMANDS.prepare("DELETE FROM receipt_shortcut_imports"),
    env.COMMANDS.prepare("DELETE FROM receipt_scan_sessions"),
    env.COMMANDS.prepare("DELETE FROM household_members"),
    env.COMMANDS.prepare("DELETE FROM households"),
  ]);
  await env.COMMANDS.prepare(`INSERT INTO households
    (id, name, active, created_at, updated_at) VALUES ('h','H',1,?,?)`)
    .bind(NOW.toISOString(), NOW.toISOString()).run();
  await env.COMMANDS.prepare(`INSERT INTO household_members
    (id, household_id, normalized_email, display_name, active, created_at, updated_at)
    VALUES ('m','h','m@example.test','M',1,?,?)`).bind(NOW.toISOString(), NOW.toISOString()).run();
  await env.COMMANDS.prepare(`INSERT INTO receipt_scan_sessions
    (token_digest, household_id, actor_member_id, created_at, expires_at)
    VALUES (?, 'h','m',?,?)`).bind("a".repeat(64), NOW.toISOString(),
      "2026-11-04T12:10:00.000Z").run();
  await env.COMMANDS.prepare(`INSERT INTO receipt_shortcut_imports
    (id, session_token_digest, household_id, actor_member_id, contract_version, shortcut_version,
     pages_json, model_result, validation_json, idempotency_key, body_digest, created_at, expires_at)
    VALUES ('i', ?, 'h','m',2,2,?,'{}',?, ?, ?, ?, ?)`)
    .bind("a".repeat(64), JSON.stringify([{ page_index: 0, text: "SHOP TOTAL 1.00" }]),
      JSON.stringify({ status: "needs_refinement", issues: [], receipt: {} }), "b".repeat(64),
      "c".repeat(64), NOW.toISOString(), "2026-11-04T12:30:00.000Z").run();
  await env.COMMANDS.prepare(`UPDATE receipt_scan_sessions SET consumed_import_id = 'i',
    idempotency_key = ?, body_digest = ?, consumed_at = ? WHERE token_digest = ?`)
    .bind("b".repeat(64), "c".repeat(64), NOW.toISOString(), "a".repeat(64)).run();
});

describe("receipt refinement store", () => {
  it("creates once, claims with a five-minute lease, and completes idempotently", async () => {
    const store = new ReceiptRefinementStore(env.COMMANDS, () => NOW);
    const created = await store.createForImport("i", "h", "m", "d".repeat(64));
    expect((await store.createForImport("i", "h", "m", "d".repeat(64))).id).toBe(created.id);
    const [claim] = await store.claim(3);
    expect(claim).toMatchObject({ id: created.id, input_digest: "d".repeat(64) });
    expect(claim.claim_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const result = await store.complete(created.id, claim.claim_token, "d".repeat(64),
      "SHOP\nTOTAL 1.00", JSON.stringify({ merchant: { value: "SHOP", evidence: "SHOP" }, date: null,
        subtotal: null, discounts: [], tax: null, tip: null, fees: [],
        total: { value_cents: 100, evidence: "TOTAL 1.00" }, lines: [] }));
    expect(result.status).toBe("completed");
    expect((await store.complete(created.id, claim.claim_token, "d".repeat(64),
      "SHOP\nTOTAL 1.00", JSON.stringify({ merchant: { value: "SHOP", evidence: "SHOP" }, date: null,
        subtotal: null, discounts: [], tax: null, tip: null, fees: [],
        total: { value_cents: 100, evidence: "TOTAL 1.00" }, lines: [] }))).status).toBe("completed");
    await expect(store.complete(created.id, "x".repeat(43), "d".repeat(64),
      "SHOP\nTOTAL 1.00", JSON.stringify({ merchant: { value: "SHOP", evidence: "SHOP" }, date: null,
        subtotal: null, discounts: [], tax: null, tip: null, fees: [],
        total: { value_cents: 100, evidence: "TOTAL 1.00" }, lines: [] })))
      .rejects.toThrow("REFINEMENT_CLAIM_INVALID");
    expect((await env.COMMANDS.prepare("SELECT expires_at FROM receipt_shortcut_imports WHERE id = 'i'")
      .first<{ expires_at: string }>())?.expires_at).toBe("2026-11-04T12:30:00.000Z");
  });

  it("rejects changed input, wrong claim tokens, and changed completion", async () => {
    const store = new ReceiptRefinementStore(env.COMMANDS, () => NOW);
    const job = await store.createForImport("i", "h", "m", "d".repeat(64));
    const [claim] = await store.claim(1);
    await expect(store.complete(job.id, "x".repeat(43), "d".repeat(64), "x", "{}"))
      .rejects.toThrow("REFINEMENT_CLAIM_INVALID");
    await expect(store.complete(job.id, claim.claim_token, "e".repeat(64), "x", "{}"))
      .rejects.toThrow("REFINEMENT_INPUT_CHANGED");
    const firstText = "SHOP\nTOTAL 1.00";
    const firstModel = JSON.stringify({ merchant: { value: "SHOP", evidence: "SHOP" }, date: null,
      subtotal: null, discounts: [], tax: null, tip: null, fees: [],
      total: { value_cents: 100, evidence: "TOTAL 1.00" }, lines: [] });
    await store.complete(job.id, claim.claim_token, "d".repeat(64), firstText, firstModel);
    await expect(store.complete(job.id, claim.claim_token, "d".repeat(64),
      "SHOP\nTOTAL 2.00", JSON.stringify({ merchant: { value: "SHOP", evidence: "SHOP" }, date: null,
        subtotal: null, discounts: [], tax: null, tip: null, fees: [],
        total: { value_cents: 200, evidence: "TOTAL 2.00" }, lines: [] })))
      .rejects.toThrow("REFINEMENT_ALREADY_COMPLETED");
  });

  it("returns at most three jobs and records only safe failure codes", async () => {
    const store = new ReceiptRefinementStore(env.COMMANDS, () => NOW);
    const job = await store.createForImport("i", "h", "m", "d".repeat(64));
    const [claim] = await store.claim(99);
    expect(await store.claim(3)).toHaveLength(0);
    await store.fail(job.id, claim.claim_token, "MODEL_UNAVAILABLE");
    const row = await env.COMMANDS.prepare("SELECT status, error_code FROM receipt_refinements WHERE id = ?")
      .bind(job.id).first<{ status: string; error_code: string }>();
    expect(row).toEqual({ status: "failed", error_code: "MODEL_UNAVAILABLE" });
    await expect(store.fail(job.id, claim.claim_token, "private receipt text"))
      .rejects.toThrow("REFINEMENT_ERROR_INVALID");
  });
});
