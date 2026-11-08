import type {
  ComparedReceiptModelRun,
  ReceiptModelComparison,
  ReceiptModelRoute,
} from "./receiptModelComparison";

const THIRTY_DAYS = 30 * 24 * 60 * 60_000;
const MATERIAL_ARITHMETIC_ISSUES = new Set([
  "summary_arithmetic_mismatch",
  "item_arithmetic_mismatch",
]);

export type ReceiptBenchmarkSelection = ReceiptModelRoute | "tie" | "neither";

export interface ReceiptBenchmarkSummary {
  total: number;
  selections: Record<ReceiptBenchmarkSelection | "unselected", number>;
  on_device: ReceiptRouteSummary;
  private_cloud_compute: ReceiptRouteSummary;
}

export interface ReceiptRouteSummary {
  completed: number;
  accepted: number;
  needs_review: number;
  needs_refinement: number;
  unavailable: number;
  median_duration_ms: number | null;
}

interface BenchmarkRow {
  id: string;
  household_id: string;
  actor_member_id: string;
  selection: ReceiptBenchmarkSelection | null;
}

interface SummaryRow {
  on_device_status: ComparedReceiptModelRun["status"];
  on_device_duration_ms: number;
  on_device_validation_status: "accepted" | "needs_review" | "needs_refinement" | null;
  pcc_status: ComparedReceiptModelRun["status"];
  pcc_duration_ms: number;
  pcc_validation_status: "accepted" | "needs_review" | "needs_refinement" | null;
  selection: ReceiptBenchmarkSelection | null;
}

export class ReceiptBenchmarkStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ReceiptBenchmarkStoreError"; }
}

export class ReceiptBenchmarkStore {
  constructor(
    private readonly database: D1Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async record(
    householdId: string,
    memberId: string,
    comparison: ReceiptModelComparison,
  ): Promise<string> {
    await this.cleanup();
    const id = crypto.randomUUID();
    const now = this.clock();
    const onDevice = comparison.runs.find((run) => run.model === "on_device");
    const pcc = comparison.runs.find((run) => run.model === "private_cloud_compute");
    if (!onDevice || !pcc) throw new ReceiptBenchmarkStoreError("INVALID_RECEIPT_MODEL_COMPARISON");
    const left = metrics(onDevice);
    const right = metrics(pcc);
    await this.database.prepare(`INSERT INTO receipt_model_benchmarks (
      id, household_id, actor_member_id, shortcut_version,
      on_device_status, on_device_duration_ms, on_device_validation_status,
      on_device_issue_count, on_device_supported_line_count, on_device_total_present,
      on_device_arithmetic_reconciled, pcc_status, pcc_duration_ms, pcc_validation_status,
      pcc_issue_count, pcc_supported_line_count, pcc_total_present, pcc_arithmetic_reconciled,
      recommendation, material_disagreement, created_at, expires_at
    ) VALUES (?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, householdId, memberId,
        left.status, left.duration, left.validationStatus, left.issueCount, left.lineCount,
        left.totalPresent, left.arithmeticReconciled,
        right.status, right.duration, right.validationStatus, right.issueCount, right.lineCount,
        right.totalPresent, right.arithmeticReconciled,
        comparison.recommendation, Number(comparison.material_disagreement), now.toISOString(),
        new Date(now.getTime() + THIRTY_DAYS).toISOString())
      .run();
    return id;
  }

  async select(
    householdId: string,
    memberId: string,
    benchmarkId: string,
    selection: ReceiptBenchmarkSelection,
  ): Promise<void> {
    await this.cleanup();
    const row = await this.database.prepare(`SELECT id, household_id, actor_member_id, selection
      FROM receipt_model_benchmarks WHERE id = ? AND household_id = ? AND actor_member_id = ?
      AND expires_at > ?`).bind(benchmarkId, householdId, memberId, this.clock().toISOString())
      .first<BenchmarkRow>();
    if (!row) throw new ReceiptBenchmarkStoreError("RECEIPT_BENCHMARK_NOT_FOUND");
    if (row.selection && row.selection !== selection) {
      throw new ReceiptBenchmarkStoreError("RECEIPT_BENCHMARK_ALREADY_SELECTED");
    }
    if (!row.selection) {
      await this.database.prepare(`UPDATE receipt_model_benchmarks SET selection = ?
        WHERE id = ? AND selection IS NULL`).bind(selection, benchmarkId).run();
    }
  }

  async listSummary(householdId: string, memberId: string): Promise<ReceiptBenchmarkSummary> {
    await this.cleanup();
    const rows = (await this.database.prepare(`SELECT on_device_status, on_device_duration_ms,
      on_device_validation_status, pcc_status, pcc_duration_ms, pcc_validation_status, selection
      FROM receipt_model_benchmarks WHERE household_id = ? AND actor_member_id = ? AND expires_at > ?
      ORDER BY created_at ASC`).bind(householdId, memberId, this.clock().toISOString()).all<SummaryRow>()).results;
    return summarize(rows);
  }

  async deleteHistory(householdId: string, memberId: string): Promise<void> {
    await this.database.prepare(`DELETE FROM receipt_model_benchmarks
      WHERE household_id = ? AND actor_member_id = ?`).bind(householdId, memberId).run();
  }

  async cleanup(): Promise<void> {
    await this.database.prepare("DELETE FROM receipt_model_benchmarks WHERE expires_at <= ?")
      .bind(this.clock().toISOString()).run();
  }
}

function metrics(run: ComparedReceiptModelRun) {
  const issues = run.validation?.issues ?? [];
  return {
    status: run.status,
    duration: run.duration_ms,
    validationStatus: run.validation?.status ?? null,
    issueCount: issues.length,
    lineCount: run.validation?.receipt.lines.length ?? 0,
    totalPresent: Number(run.validation?.receipt.total !== null && run.validation !== null),
    arithmeticReconciled: Number(run.validation !== null
      && !issues.some((issue) => MATERIAL_ARITHMETIC_ISSUES.has(issue))),
  };
}

function summarize(rows: SummaryRow[]): ReceiptBenchmarkSummary {
  const selections = { on_device: 0, private_cloud_compute: 0, tie: 0, neither: 0, unselected: 0 };
  for (const row of rows) selections[row.selection ?? "unselected"] += 1;
  return {
    total: rows.length,
    selections,
    on_device: routeSummary(rows, "on_device"),
    private_cloud_compute: routeSummary(rows, "private_cloud_compute"),
  };
}

function routeSummary(rows: SummaryRow[], route: ReceiptModelRoute): ReceiptRouteSummary {
  const prefix = route === "on_device" ? "on_device" : "pcc";
  const statuses = rows.map((row) => ({
    status: row[`${prefix}_status`],
    duration: row[`${prefix}_duration_ms`],
    validation: row[`${prefix}_validation_status`],
  }));
  const completedDurations = statuses.filter((row) => row.status === "completed")
    .map((row) => row.duration).sort((a, b) => a - b);
  return {
    completed: statuses.filter((row) => row.status === "completed").length,
    accepted: statuses.filter((row) => row.validation === "accepted").length,
    needs_review: statuses.filter((row) => row.validation === "needs_review").length,
    needs_refinement: statuses.filter((row) => row.validation === "needs_refinement").length,
    unavailable: statuses.filter((row) => row.status !== "completed").length,
    median_duration_ms: median(completedDurations),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
}
