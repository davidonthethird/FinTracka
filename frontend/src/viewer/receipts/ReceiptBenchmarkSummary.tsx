import { useEffect, useState } from "react";
import { BarChart3, Copy, Trash2 } from "lucide-react";

import {
  deleteReceiptBenchmarkHistory,
  getReceiptBenchmarkSummary,
  type ReceiptBenchmarkSummary as Summary,
} from "./receiptShortcutApi";

export function ReceiptBenchmarkSummary() {
  const [summary, setSummary] = useState<Summary>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    getReceiptBenchmarkSummary().then(setSummary).catch(() => undefined);
  }, []);
  if (!summary) return null;

  async function remove() {
    setError("");
    try {
      await deleteReceiptBenchmarkHistory();
      setSummary((value) => value ? { ...value, total: 0,
        selections: { on_device: 0, private_cloud_compute: 0, tie: 0, neither: 0, unselected: 0 },
        on_device: emptyRoute(), private_cloud_compute: emptyRoute() } : value);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "History could not be removed."); }
  }

  async function copyDiagnostic() {
    setError("");
    try {
      await navigator.clipboard.writeText(receiptBenchmarkDiagnostic(summary!));
      setCopied(true);
    } catch {
      setError("The diagnostic report could not be copied.");
    }
  }

  return <section className="receipt-benchmark-summary" aria-labelledby="receipt-benchmark-title">
    <header><BarChart3 /><div><span>Last 30 days</span><h2 id="receipt-benchmark-title">Apple model benchmark</h2></div></header>
    {summary.total === 0 ? <p>No compared receipts yet.</p> : <>
      <p>{summary.total} compared receipt{summary.total === 1 ? "" : "s"}. Your reviewed choices—not speed—decide the winner.</p>
      <div className="receipt-benchmark-routes">
        <Route name="On-device" summary={summary.on_device} selected={summary.selections.on_device} />
        <Route name="Private Cloud Compute" summary={summary.private_cloud_compute}
          selected={summary.selections.private_cloud_compute} />
      </div>
      <div className="receipt-benchmark-actions">
        <button className="secondary-button" onClick={() => void copyDiagnostic()}><Copy />
          {copied ? "Copied" : "Copy diagnostic report"}</button>
        <button className="secondary-button" onClick={() => void remove()}><Trash2 />Delete benchmark history</button>
      </div>
    </>}
    {error && <p className="receipt-error" role="alert">{error}</p>}
  </section>;
}

export function receiptBenchmarkDiagnostic(summary: Summary): string {
  return JSON.stringify({
    contract: "receipt_model_benchmark_diagnostic/v1",
    period_days: 30,
    total: summary.total,
    selections: summary.selections,
    routes: {
      on_device: summary.on_device,
      private_cloud_compute: summary.private_cloud_compute,
    },
  }, null, 2);
}

function Route({ name, summary, selected }: {
  name: string; summary: Summary["on_device"]; selected: number;
}) {
  return <article><h3>{name}</h3><dl>
    <div><dt>Selected</dt><dd>{selected}</dd></div>
    <div><dt>Evidence verified</dt><dd>{summary.accepted}/{summary.completed}</dd></div>
    <div><dt>Unavailable</dt><dd>{summary.unavailable}</dd></div>
    <div><dt>Median time</dt><dd>{summary.median_duration_ms === null
      ? "—" : `${(summary.median_duration_ms / 1_000).toFixed(1)} sec`}</dd></div>
  </dl></article>;
}

function emptyRoute(): Summary["on_device"] {
  return { completed: 0, accepted: 0, needs_review: 0, needs_refinement: 0,
    unavailable: 0, median_duration_ms: null };
}
