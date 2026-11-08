import type { ReceiptValidationResult } from "./receiptInterpretation";
import { validateReceiptInterpretation } from "./receiptInterpretation";

export type ReceiptModelRoute = "on_device" | "private_cloud_compute";

export type ReceiptModelRun =
  | { model: ReceiptModelRoute; status: "completed"; duration_ms: number; model_result: string }
  | { model: ReceiptModelRoute; status: "unavailable" | "rate_limited" | "failed";
    duration_ms: number; error_code: string };

export type ComparedReceiptModelRun =
  | { model: ReceiptModelRoute; status: "completed"; duration_ms: number;
    validation: ReceiptValidationResult }
  | { model: ReceiptModelRoute; status: "unavailable" | "rate_limited" | "failed";
    duration_ms: number; error_code: string; validation: null };

export interface ReceiptModelComparison {
  runs: ComparedReceiptModelRun[];
  recommendation: ReceiptModelRoute | "tie" | "neither";
  material_disagreement: boolean;
}

const ROUTE_ORDER: ReceiptModelRoute[] = ["on_device", "private_cloud_compute"];

export function compareReceiptModelRuns(rawText: string, input: ReceiptModelRun[]): ReceiptModelComparison {
  const runs = ROUTE_ORDER.map((route) => {
    const run = input.find((candidate) => candidate.model === route);
    if (!run) throw new Error(`missing receipt model route: ${route}`);
    return run.status === "completed"
      ? { model: run.model, status: run.status, duration_ms: run.duration_ms,
        validation: validateReceiptInterpretation(rawText, run.model_result) }
      : { model: run.model, status: run.status, duration_ms: run.duration_ms,
        error_code: run.error_code, validation: null };
  });
  const usable = runs.filter((run): run is Extract<ComparedReceiptModelRun, { status: "completed" }> =>
    run.validation !== null && run.validation.status !== "needs_refinement");
  const materialDisagreement = usable.length === 2 && materiallyDifferent(usable[0], usable[1]);
  if (usable.length === 0) return { runs, recommendation: "neither", material_disagreement: false };
  if (usable.length === 1) return { runs, recommendation: usable[0].model, material_disagreement: false };
  if (materialDisagreement) return { runs, recommendation: "tie", material_disagreement: true };
  const [first, second] = usable;
  const delta = rank(first.validation!) - rank(second.validation!);
  return { runs, recommendation: delta > 0 ? first.model : delta < 0 ? second.model : "tie",
    material_disagreement: false };
}

function rank(validation: ReceiptValidationResult): number {
  const state = validation.status === "accepted" ? 2 : validation.status === "needs_review" ? 1 : 0;
  const materialIssues = validation.issues.filter((issue) => issue !== "unsupported_date"
    && issue !== "layout_association_unverified").length;
  const reconciled = !validation.issues.includes("summary_arithmetic_mismatch")
    && !validation.issues.includes("item_arithmetic_mismatch") ? 1 : 0;
  return state * 1_000_000 - materialIssues * 10_000 + reconciled * 1_000
    + validation.receipt.lines.length;
}

function materiallyDifferent(a: ComparedReceiptModelRun, b: ComparedReceiptModelRun): boolean {
  const left = a.validation!.receipt;
  const right = b.validation!.receipt;
  return left.merchant?.value !== right.merchant?.value
    || left.total?.value_cents !== right.total?.value_cents
    || JSON.stringify(left.lines.map((line) => [line.description, line.amount_cents]))
      !== JSON.stringify(right.lines.map((line) => [line.description, line.amount_cents]));
}
