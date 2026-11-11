import { useCallback, useEffect, useState } from "react";
import { Camera, ChevronRight, Clock3, ReceiptText, TriangleAlert, X } from "lucide-react";

import type { ReceiptDraft } from "./types";
import { useReceipts } from "./ReceiptProvider";
import { listReceiptQueueHandoffs, type ReceiptQueueHandoff } from "./receiptShortcutApi";

export function ReceiptInboxPage({ navigate }: { navigate: (path: string) => void }) {
  const receipts = useReceipts();
  if (receipts.loading) return <div className="viewer-empty"><h2>Loading receipt drafts…</h2></div>;
  if (!receipts.available) return <div className="viewer-page"><ReceiptHeader />
    <div className="viewer-empty"><h2>Receipt scanning is not enabled yet</h2><p>{receipts.error || "The private staging gate must pass first."}</p></div></div>;
  return <div className="viewer-page"><ReceiptHeader />
    <ReceiptQueueHandoffs onOpen={navigate} />
    <ReceiptInboxView drafts={receipts.drafts} onNew={() => navigate("/receipts/new")}
      onOpen={(id) => navigate(`/receipts/${encodeURIComponent(id)}`)} onDismiss={receipts.dismiss} />
  </div>;
}

function ReceiptQueueHandoffs({ onOpen }: { onOpen: (path: string) => void }) {
  const [handoffs, setHandoffs] = useState<ReceiptQueueHandoff[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setHandoffs(await listReceiptQueueHandoffs()); setError(""); }
    catch { setError("Queued receipt scans could not be refreshed."); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5_000);
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh]);
  return <>{error && <p className="receipt-error" role="status">{error}</p>}
    <ReceiptQueueHandoffView handoffs={handoffs} onOpen={onOpen} /></>;
}

export function ReceiptQueueHandoffView({ handoffs, onOpen }: {
  handoffs: ReceiptQueueHandoff[]; onOpen: (path: string) => void;
}) {
  if (!handoffs.length) return null;
  return <section className="receipt-handoffs" aria-label="Queued receipt scans">
    <h2>iPhone scans</h2>
    {handoffs.map((handoff) => {
      const ready = handoff.status === "ready" && handoff.review_path;
      const content = <><span className={`receipt-handoff-icon ${handoff.status}`}>
        {handoff.status === "failed" ? <TriangleAlert aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
      </span><span><strong>{handoffLabel(handoff.status)}</strong>
        <small>{handoff.status === "failed" ? "Scan again or check the shared iCloud folder."
          : handoff.status === "ready" ? "Your receipt is ready to open."
            : handoff.status === "processing" ? "Your Mac is preparing this receipt."
              : "Saved privately; your Mac will relay it when available."}</small></span>
        {ready && <ChevronRight aria-hidden="true" />}</>;
      return ready
        ? <button className="receipt-handoff-row" key={handoff.id}
          onClick={() => onOpen(handoff.review_path!)}>{content}</button>
        : <div className="receipt-handoff-row" key={handoff.id}>{content}</div>;
    })}
  </section>;
}

function handoffLabel(status: ReceiptQueueHandoff["status"]): string {
  return ({ pending: "Waiting for Mac", processing: "Processing", ready: "Ready to review",
    failed: "Scan needs attention" })[status];
}

export function canDismissReceipt(status: ReceiptDraft["status"]): boolean {
  return status === "editing" || status === "waiting_for_bank" || status === "conflict";
}

export function ReceiptInboxView({ drafts, onOpen, onNew, onDismiss }: {
  drafts: ReceiptDraft[]; onOpen: (id: string) => void; onNew: () => void;
  onDismiss: (draft: ReceiptDraft) => Promise<void>;
}) {
  const [dismissing, setDismissing] = useState<string>();
  const [error, setError] = useState("");
  const visible = drafts.filter((draft) => draft.status !== "dismissed");
  async function dismiss(draft: ReceiptDraft) {
    const title = draft.merchant || "Untitled receipt";
    if (!window.confirm(`Remove ${title}? This draft has not been added to spending.`)) return;
    setDismissing(draft.id); setError("");
    try { await onDismiss(draft); }
    catch { setError(`${title} could not be removed. The receipt list was refreshed.`); }
    finally { setDismissing(undefined); }
  }
  return <>
    <button className="receipt-new" onClick={onNew}><Camera aria-hidden="true" /><span><strong>Scan a receipt</strong><small>Images stay on this device</small></span></button>
    <p className="receipt-boundary"><ReceiptText aria-hidden="true" /> Drafts are uncommitted. No spending has been added until a bank transaction is explicitly matched and your Mac applies it.</p>
    {error && <p className="receipt-error" role="alert">{error}</p>}
    <section className="receipt-inbox">{visible.length ? visible.map((draft) => {
      const title = draft.merchant || "Untitled receipt";
      return <div className="receipt-inbox-row" key={draft.id}>
        <button className="receipt-inbox-open" aria-label={`Open ${title} receipt`} onClick={() => onOpen(draft.id)}>
          <span><strong>{title}</strong><small>{draft.purchase_date || "Date needed"} · {statusLabel(draft.status)}</small></span>
          <b>{money(draft.total_minor, draft.currency)}</b><ChevronRight aria-hidden="true" />
        </button>
        {canDismissReceipt(draft.status) && <button className="receipt-inbox-remove" aria-label={`Remove ${title} receipt`}
          disabled={dismissing === draft.id} onClick={() => void dismiss(draft)}><X aria-hidden="true" /></button>}
      </div>;
    }) : <div className="viewer-empty"><h2>No receipt drafts</h2><p>Photograph a receipt to split its items.</p></div>}</section>
  </>;
}

function ReceiptHeader() { return <header className="viewer-heading"><div><span>Private capture</span><h1>Receipts</h1></div></header>; }
function statusLabel(status: ReceiptDraft["status"]) { return ({ editing: "Editing", waiting_for_bank: "Waiting for bank", match_pending: "Match pending", processing: "Applying on Mac", matched: "Matched", conflict: "Needs review", dismissed: "Dismissed" })[status]; }
function money(minor: number, currency: string) { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100); }
