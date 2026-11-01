import { Camera, ChevronRight, ReceiptText } from "lucide-react";

import type { ReceiptDraft } from "./types";
import { useReceipts } from "./ReceiptProvider";

export function ReceiptInboxPage({ navigate }: { navigate: (path: string) => void }) {
  const receipts = useReceipts();
  if (receipts.loading) return <div className="viewer-empty"><h2>Loading receipt drafts…</h2></div>;
  if (!receipts.available) return <div className="viewer-page"><ReceiptHeader />
    <div className="viewer-empty"><h2>Receipt scanning is not enabled yet</h2><p>{receipts.error || "The private staging gate must pass first."}</p></div></div>;
  return <div className="viewer-page"><ReceiptHeader />
    <ReceiptInboxView drafts={receipts.drafts} onNew={() => navigate("/receipts/new")}
      onOpen={(id) => navigate(`/receipts/${encodeURIComponent(id)}`)} />
  </div>;
}

export function ReceiptInboxView({ drafts, onOpen, onNew }: {
  drafts: ReceiptDraft[]; onOpen: (id: string) => void; onNew: () => void;
}) {
  const visible = drafts.filter((draft) => draft.status !== "dismissed");
  return <>
    <button className="receipt-new" onClick={onNew}><Camera aria-hidden="true" /><span><strong>Scan a receipt</strong><small>Images stay on this device</small></span></button>
    <p className="receipt-boundary"><ReceiptText aria-hidden="true" /> Drafts are uncommitted. No spending has been added until a bank transaction is explicitly matched and your Mac applies it.</p>
    <section className="receipt-inbox">{visible.length ? visible.map((draft) => <button key={draft.id} onClick={() => onOpen(draft.id)}>
      <span><strong>{draft.merchant || "Untitled receipt"}</strong><small>{draft.purchase_date || "Date needed"} · {statusLabel(draft.status)}</small></span>
      <b>{money(draft.total_minor, draft.currency)}</b><ChevronRight aria-hidden="true" />
    </button>) : <div className="viewer-empty"><h2>No receipt drafts</h2><p>Photograph a receipt to split its items.</p></div>}</section>
  </>;
}

function ReceiptHeader() { return <header className="viewer-heading"><div><span>Private capture</span><h1>Receipts</h1></div></header>; }
function statusLabel(status: ReceiptDraft["status"]) { return ({ editing: "Editing", waiting_for_bank: "Waiting for bank", match_pending: "Match pending", processing: "Applying on Mac", matched: "Matched", conflict: "Needs review", dismissed: "Dismissed" })[status]; }
function money(minor: number, currency: string) { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100); }
