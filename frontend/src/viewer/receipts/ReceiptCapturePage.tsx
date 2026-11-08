import { useEffect, useRef, useState } from "react";
import { Camera, ExternalLink, RotateCcw, X } from "lucide-react";

import { MobileCommandApiError } from "../api";
import { buildReceiptShortcutUrl, createReceiptScanSession, type ReceiptScanSession,
  completeReceiptScanFromClipboard, watchReceiptScanSession } from "./receiptShortcutApi";
import { ReceiptBenchmarkSummary } from "./ReceiptBenchmarkSummary";

export function ReceiptCapturePage({ navigate }: { navigate: (path: string) => void }) {
  const [session, setSession] = useState<ReceiptScanSession>();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let active = true;
    setSession(undefined); setError("");
    createReceiptScanSession().then((value) => { if (active) setSession(value); })
      .catch((caught) => { if (active) setError(caught instanceof MobileCommandApiError && caught.code === "NOT_FOUND"
        ? "Receipt scanning is not enabled yet."
        : caught instanceof Error ? caught.message : "Secure scan preparation failed."); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (!session) return;
    return watchReceiptScanSession(session.token, {
      onReady: navigate,
      onError: (caught) => setError(caught instanceof Error
        ? caught.message : "The receipt scan could not be checked."),
    });
  }, [navigate, session]);

  async function importResults() {
    if (!session || importing) return;
    setImporting(true); setError("");
    try { navigate(await completeReceiptScanFromClipboard(session)); }
    catch (caught) {
      setError(caught instanceof Error ? caught.message : "The receipt results could not be imported.");
      setImporting(false);
    }
  }

  return <div className="viewer-page"><header className="viewer-heading"><div><span>Apple Vision</span><h1>Scan receipt</h1></div>
    <button className="icon-button" onClick={() => navigate("/receipts")} aria-label="Close"><X /></button></header>
    <section className="receipt-capture" aria-busy={!session && !error}>
      <Camera aria-hidden="true" /><h2>{session ? "Open the receipt scanner" : "Preparing secure scan"}</h2>
      <p>Take photos or choose them from your library. Recognition stays on your Apple devices. Only scans that need help are placed temporarily in your private shared iCloud folder for your Mac to refine.</p>
      {!session && !error && <p role="status">Creating a private, one-time connection…</p>}
      {session && <a className="receipt-shortcut-launch" href={buildReceiptShortcutUrl(session)}>
        <ExternalLink aria-hidden="true" />Scan with iPhone</a>}
      {session && <p role="status">After the scan finishes, tap <strong>Back to FinTracka</strong>.
        Then import the recognized text below.</p>}
      {session && <button className="receipt-camera receipt-import-results" disabled={importing}
        onClick={() => void importResults()}>{importing ? "Importing…" : "Import scan results"}</button>}
      {error && <><p className="receipt-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>
        <button className="secondary-button" onClick={() => setAttempt((value) => value + 1)}><RotateCcw />Try again</button></>}
      <small className="receipt-session-note">The one-time connection expires in 10 minutes and is never saved in this browser.</small>
      <details className="receipt-shortcut-help"><summary>Shortcut not installed or out of date?</summary>
        <p>Install version {session?.shortcut_version ?? 2} and name it exactly <strong>{session?.shortcut_name ?? "FinTracka Receipt Scanner"}</strong>. If it still will not open, run it once in the Shortcuts app to accept permissions, return here, and start a new scan.</p>
      </details>
    </section>
    {session?.comparison_enabled && <ReceiptBenchmarkSummary />}
  </div>;
}
