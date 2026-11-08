import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ReceiptBenchmarkStore } from "../src/receiptBenchmarkStore";
import { compareReceiptModelRuns } from "../src/receiptModelComparison";

declare global {
  namespace Cloudflare {
    interface Env {
      COMMANDS: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const NOW = new Date("2026-11-08T12:00:00.000Z");
const HOUSEHOLD = "benchmark-household";
const MEMBER = "benchmark-member";
const OTHER = "benchmark-other";

beforeAll(async () => applyD1Migrations(env.COMMANDS, env.TEST_MIGRATIONS));

beforeEach(async () => {
  await env.COMMANDS.batch([
    env.COMMANDS.prepare("DELETE FROM receipt_model_benchmarks"),
    env.COMMANDS.prepare("DELETE FROM household_members"),
    env.COMMANDS.prepare("DELETE FROM households"),
  ]);
  const now = NOW.toISOString();
  await env.COMMANDS.batch([
    env.COMMANDS.prepare("INSERT INTO households (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
      .bind(HOUSEHOLD, "Benchmark household", now, now),
    ...[[MEMBER, "member@example.test"], [OTHER, "other@example.test"]].map(([id, email]) =>
      env.COMMANDS.prepare(`INSERT INTO household_members
        (id, household_id, normalized_email, display_name, role, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'member', 1, ?, ?)`).bind(id, HOUSEHOLD, email, id, now, now)),
  ]);
});

describe("receipt benchmark store", () => {
  it("persists only allowlisted metadata and expires it after thirty days", async () => {
    let now = NOW;
    const store = new ReceiptBenchmarkStore(env.COMMANDS, () => now);
    await store.record(HOUSEHOLD, MEMBER, comparison());
    const columns = (await env.COMMANDS.prepare("PRAGMA table_info(receipt_model_benchmarks)")
      .all<{ name: string }>()).results.map((row) => row.name);
    expect(columns).toEqual([
      "id", "household_id", "actor_member_id", "shortcut_version",
      "on_device_status", "on_device_duration_ms", "on_device_validation_status",
      "on_device_issue_count", "on_device_supported_line_count", "on_device_total_present",
      "on_device_arithmetic_reconciled", "pcc_status", "pcc_duration_ms",
      "pcc_validation_status", "pcc_issue_count", "pcc_supported_line_count",
      "pcc_total_present", "pcc_arithmetic_reconciled", "recommendation",
      "material_disagreement", "selection", "created_at", "expires_at",
    ]);
    expect(JSON.stringify(await store.listSummary(HOUSEHOLD, MEMBER)))
      .not.toMatch(/Synthetic|ITEM|TOTAL|10\.00/);
    now = new Date("2026-12-08T12:00:00.001Z");
    expect((await store.listSummary(HOUSEHOLD, MEMBER)).total).toBe(0);
  });

  it("isolates immutable selections by member and summarizes completed routes", async () => {
    const store = new ReceiptBenchmarkStore(env.COMMANDS, () => NOW);
    const id = await store.record(HOUSEHOLD, MEMBER, comparison());
    await expect(store.select(HOUSEHOLD, OTHER, id, "on_device"))
      .rejects.toMatchObject({ code: "RECEIPT_BENCHMARK_NOT_FOUND" });
    await store.select(HOUSEHOLD, MEMBER, id, "on_device");
    await store.select(HOUSEHOLD, MEMBER, id, "on_device");
    await expect(store.select(HOUSEHOLD, MEMBER, id, "private_cloud_compute"))
      .rejects.toMatchObject({ code: "RECEIPT_BENCHMARK_ALREADY_SELECTED" });
    expect(await store.listSummary(HOUSEHOLD, MEMBER)).toMatchObject({
      total: 1,
      selections: { on_device: 1, private_cloud_compute: 0, tie: 0, neither: 0, unselected: 0 },
      on_device: { completed: 1, accepted: 1, median_duration_ms: 1200 },
      private_cloud_compute: { completed: 1, accepted: 1, median_duration_ms: 2400 },
    });
    expect((await store.listSummary(HOUSEHOLD, OTHER)).total).toBe(0);
  });
});

function comparison() {
  const text = "Synthetic Market\nITEM 10.00\nTOTAL 10.00";
  const result = JSON.stringify({
    merchant: { value: "Synthetic Market", evidence: "Synthetic Market" },
    date: null, subtotal: null, discounts: [], tax: null, tip: null, fees: [],
    total: { value_cents: 1000, evidence: "TOTAL 10.00" },
    lines: [{ description: "ITEM", amount_cents: 1000,
      description_evidence: "ITEM 10.00", amount_evidence: "ITEM 10.00" }],
  });
  return compareReceiptModelRuns(text, [
    { model: "on_device", status: "completed", duration_ms: 1200, model_result: result },
    { model: "private_cloud_compute", status: "completed", duration_ms: 2400, model_result: result },
  ]);
}
