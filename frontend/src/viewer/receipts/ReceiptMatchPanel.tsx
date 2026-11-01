import { useMemo, useState } from "react";
import { CheckCircle2, Landmark } from "lucide-react";

import type { RemoteTransaction } from "../model";
import { receiptCandidates } from "./receiptMatching";
import type { ReceiptDraft } from "./types";

export function ReceiptMatchPanel({ draft, transactions, available, onMatch }: {
  draft: ReceiptDraft; transactions: RemoteTransaction[]; available: boolean;
  onMatch: (transactionId: string, splitRevision: number) => Promise<void>;
}) {
  const candidates = useMemo(() => receiptCandidates(draft, transactions), [draft, transactions]);
  const [selected, setSelected] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  if (draft.status === "match_pending" || draft.status === "processing") {
    return <section className="receipt-match-state"><CheckCircle2 /><h2>Match queued safely</h2>
      <p>Your Mac will apply the item splits exactly once, then publish a fresh snapshot.</p></section>;
  }
  if (draft.status === "matched") return <section className="receipt-match-state"><CheckCircle2 />
    <h2>Receipt matched</h2><p>This receipt’s item-level split is now part of your ledger.</p></section>;
  if (!available) return <section className="receipt-match-state"><Landmark /><h2>Waiting for matching</h2>
    <p>Capture and review are safe. Financial matching remains disabled until the Mac and private gateway are ready.</p></section>;
  async function submit() {
    const candidate = candidates.find((item) => item.transaction.id === selected);
    if (!candidate) return;
    setWorking(true); setError("");
    try { await onMatch(candidate.transaction.id, candidate.transaction.split_revision); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Match submission failed."); }
    finally { setWorking(false); }
  }
  return <section className="receipt-match"><header><div><span>Explicit bank match</span><h2>Choose the purchase</h2></div>
    <strong>{candidates.length} exact {candidates.length === 1 ? "candidate" : "candidates"}</strong></header>
    <p>FinTracka only shows posted transactions with the same total, currency, and a date within seven days. It never selects one automatically.</p>
    {error && <p className="receipt-error" role="alert">{error}</p>}
    {candidates.length === 0 ? <div className="receipt-no-match"><Landmark /><b>No exact posted match yet</b><span>Sync again after the bank transaction posts.</span></div>
      : <div className="receipt-candidates">{candidates.map(({ transaction, dayDistance }) => <label key={transaction.id}>
        <input type="radio" name="receipt-match" value={transaction.id} checked={selected === transaction.id}
          onChange={() => setSelected(transaction.id)} /><span><b>{transaction.merchant || transaction.description}</b>
          <small>{transaction.local_date} · {transaction.account_name} · {dayDistance === 0 ? "same day" : `${dayDistance} days away`}</small></span>
        <strong>{money(Math.abs(transaction.amount_minor), transaction.currency)}</strong></label>)}</div>}
    <button className="receipt-match-button" disabled={!selected || working} onClick={() => void submit()}>
      {working ? "Queuing…" : "Match selected transaction"}</button>
  </section>;
}

function money(minor: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}
