#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [truthPath, resultsPath] = process.argv.slice(2);
if (!truthPath || !resultsPath) {
  console.error("usage: summarize-receipt-benchmark.mjs TRUTH_JSON REVIEWED_RESULTS_JSON");
  process.exit(2);
}

const truth = JSON.parse(readFileSync(truthPath, "utf8"));
const results = JSON.parse(readFileSync(resultsPath, "utf8"));
if (truth.contract !== "receipt_benchmark_truth/v1"
    || results.contract !== "receipt_benchmark_reviewed_results/v1") {
  throw new Error("unsupported benchmark contract");
}

const expected = new Map(truth.receipts.map((receipt) => [receipt.id, receipt]));
for (const route of ["on_device", "private_cloud_compute"]) {
  const runs = results.runs.filter((run) => run.route === route);
  const scored = runs.filter((run) => expected.has(run.receipt_id) && run.status === "completed");
  const merchant = scored.filter((run) => normalized(run.merchant)
    === normalized(expected.get(run.receipt_id).merchant)).length;
  const total = scored.filter((run) => run.total_cents === expected.get(run.receipt_id).total_cents).length;
  let truePositive = 0; let predicted = 0; let actual = 0;
  for (const run of scored) {
    const wanted = new Set(expected.get(run.receipt_id).lines.map(lineKey));
    const got = new Set((run.lines ?? []).map(lineKey));
    actual += wanted.size; predicted += got.size;
    truePositive += [...got].filter((line) => wanted.has(line)).length;
  }
  const durations = runs.map((run) => run.duration_ms).filter(Number.isFinite).sort((a, b) => a - b);
  const reconciled = scored.filter((run) => run.reconciled === true).length;
  console.log(JSON.stringify({
    route,
    attempted: runs.length,
    completed: scored.length,
    failure_rate: ratio(runs.length - scored.length, runs.length),
    merchant_exact_rate: ratio(merchant, scored.length),
    total_exact_rate: ratio(total, scored.length),
    line_precision: ratio(truePositive, predicted),
    line_recall: ratio(truePositive, actual),
    reconciliation_rate: ratio(reconciled, scored.length),
    median_duration_ms: durations.length ? durations[Math.floor((durations.length - 1) / 2)] : null,
    worst_duration_ms: durations.at(-1) ?? null,
    selected_count: results.selections?.[route] ?? 0,
  }));
}

function normalized(value) { return String(value ?? "").normalize("NFKC").trim().toLowerCase(); }
function lineKey(line) { return `${normalized(line.description)}\u0000${line.amount_cents}`; }
function ratio(part, whole) { return whole ? Number((part / whole).toFixed(4)) : null; }
