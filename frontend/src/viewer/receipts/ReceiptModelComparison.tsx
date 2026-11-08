import { AlertTriangle, CheckCircle2, Cloud, Cpu, XCircle } from "lucide-react";

import type {
  ReceiptModelComparison as Comparison,
  ReceiptModelRoute,
  ReceiptModelSelection,
} from "./receiptShortcutApi";

export function ReceiptModelComparison({
  comparison,
  disabled,
  onSelect,
}: {
  comparison: Comparison;
  disabled?: boolean;
  onSelect: (selection: ReceiptModelSelection) => void;
}) {
  return <section className="receipt-model-comparison" aria-labelledby="receipt-comparison-title">
    <div className="receipt-model-comparison-heading">
      <div><span>Private benchmark</span><h2 id="receipt-comparison-title">Compare Apple results</h2></div>
      {comparison.material_disagreement && <p className="receipt-comparison-warning"><AlertTriangle />
        The models disagree on receipt details. Check the photo before choosing.</p>}
    </div>
    <div className="receipt-model-cards">
      {comparison.runs.map((run) => <article className="receipt-model-card" key={run.model}>
        <header>{run.model === "on_device" ? <Cpu /> : <Cloud />}
          <div><h3>{label(run.model)}</h3><small>{formatDuration(run.duration_ms)}</small></div></header>
        {run.validation ? <>
          <p className={`receipt-model-status ${run.validation.status}`}>
            {run.validation.status === "accepted" ? <CheckCircle2 /> : <AlertTriangle />}
            {statusLabel(run.validation.status)}</p>
          <dl>
            <div><dt>Merchant</dt><dd>{run.validation.receipt?.merchant?.value ?? "Not found"}</dd></div>
            <div><dt>Total</dt><dd>{money(run.validation.receipt?.total?.value_cents)}</dd></div>
            <div><dt>Items</dt><dd>{run.validation.receipt?.lines.length ?? 0}</dd></div>
          </dl>
          {run.validation.issues.length > 0 && <details><summary>Review warnings</summary>
            <ul>{run.validation.issues.map((issue) => <li key={issue}>{issueLabel(issue)}</li>)}</ul>
          </details>}
          <button disabled={disabled || run.validation.status === "needs_refinement"}
            onClick={() => onSelect(run.model)}>Use {label(run.model)}</button>
        </> : <><p className="receipt-model-status unavailable"><XCircle />{runStatus(run.status)}</p>
          <button disabled>Result unavailable</button></>}
      </article>)}
    </div>
    <p className="receipt-model-recommendation">FinTracka recommendation: <strong>
      {comparison.recommendation === "tie" ? "review both"
        : comparison.recommendation === "neither" ? "use neither"
          : label(comparison.recommendation)}</strong>. Accuracy matters more than speed.</p>
    <button className="secondary-button receipt-model-neither" disabled={disabled}
      onClick={() => onSelect("neither")}>Neither result is correct</button>
  </section>;
}

function label(route: ReceiptModelRoute): string {
  return route === "on_device" ? "On-device" : "Private Cloud Compute";
}

function statusLabel(status: "accepted" | "needs_review" | "needs_refinement"): string {
  return status === "accepted" ? "Evidence verified"
    : status === "needs_review" ? "Review suggested" : "Not safe to use";
}

function runStatus(status: string): string {
  return status === "rate_limited" ? "Temporarily rate limited"
    : status === "unavailable" ? "Unavailable on this device" : "Model run failed";
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)} sec`;
}

function money(cents: number | undefined): string {
  return cents === undefined ? "Not found" : new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD",
  }).format(cents / 100);
}

function issueLabel(issue: string): string {
  const labels: Record<string, string> = {
    layout_association_unverified: "Item and price appeared in separate columns; verify their pairing.",
    summary_arithmetic_mismatch: "The printed summary does not reconcile.",
    item_arithmetic_mismatch: "Item prices do not add up to the subtotal.",
    unsupported_date: "The date could not be verified from recognized text.",
  };
  return labels[issue] ?? "Some recognized details could not be verified.";
}
