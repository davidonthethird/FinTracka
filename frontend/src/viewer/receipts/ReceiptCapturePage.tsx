import { useEffect, useRef, useState } from "react";
import { Camera, ExternalLink, RotateCcw, X } from "lucide-react";

import { MobileCommandApiError } from "../api";
import { buildReceiptShortcutUrl, createReceiptScanSession, type ReceiptScanSession } from "./receiptShortcutApi";

export function ReceiptCapturePage({ navigate }: { navigate: (path: string) => void }) {
  const [session, setSession] = useState<ReceiptScanSession>();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
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

  return <div className="viewer-page"><header className="viewer-heading"><div><span>Apple Vision</span><h1>Scan receipt</h1></div>
    <button className="icon-button" onClick={() => navigate("/receipts")} aria-label="Close"><X /></button></header>
    <section className="receipt-capture" aria-busy={!session && !error}>
      <Camera aria-hidden="true" /><h2>{session ? "Open the receipt scanner" : "Preparing secure scan"}</h2>
      <p>Take photos or choose them from your library. Recognition and photos stay on your iPhone; only the recognized text returns to FinTracka.</p>
      {!session && !error && <p role="status">Creating a private, one-time connection…</p>}
      {session && <a className="receipt-shortcut-launch" href={buildReceiptShortcutUrl(session)}>
        <ExternalLink aria-hidden="true" />Scan with iPhone</a>}
      {error && <><p className="receipt-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>
        <button className="secondary-button" onClick={() => setAttempt((value) => value + 1)}><RotateCcw />Try again</button></>}
      <small className="receipt-session-note">The one-time connection expires in 10 minutes and is never saved in this browser.</small>
      <details className="receipt-shortcut-help"><summary>Shortcut not installed or out of date?</summary>
        <p>Install version 1 and name it exactly <strong>FinTracka Scan Receipt</strong>. If it still will not open, run it once in the Shortcuts app to accept permissions, return here, and start a new scan.</p>
      </details>
    </section>
  </div>;
}
