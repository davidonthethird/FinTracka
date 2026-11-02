import { useEffect, useRef, useState } from "react";
import { FileWarning, RotateCcw, Trash2, X } from "lucide-react";

import { MobileCommandApiError } from "../api";
import { draftFromParsedReceipt, isUsableParsedReceipt } from "./receiptDraftBuilder";
import { receiptPagesFromPlainText } from "./receiptPlainText";
import { parseReceiptPages } from "./receiptParser";
import { deleteReceiptImport, getReceiptImport, type PublicReceiptImport } from "./receiptShortcutApi";
import { useReceipts } from "./ReceiptProvider";
import type { ReceiptDraft, ReceiptDraftV1 } from "./types";

interface FinalizerDependencies {
  create: (draft: ReceiptDraftV1, idempotencyKey: string) => Promise<ReceiptDraft>;
  cleanup: () => Promise<void>;
  cancelled?: () => boolean;
}

export type ReceiptImportResult = { status: "created"; draft: ReceiptDraft }
  | { status: "unusable"; imported: PublicReceiptImport }
  | { status: "cancelled" };

export async function finalizeReceiptImport(
  imported: PublicReceiptImport,
  dependencies: FinalizerDependencies,
): Promise<ReceiptImportResult> {
  const parsed = parseReceiptPages(receiptPagesFromPlainText(imported.pages));
  if (!isUsableParsedReceipt(parsed)) return { status: "unusable", imported };
  if (dependencies.cancelled?.()) return { status: "cancelled" };
  const draft = await dependencies.create(draftFromParsedReceipt(parsed, imported.pages.length),
    `shortcut-import-${imported.id}`);
  try { await dependencies.cleanup(); } catch { /* deterministic replay retries cleanup */ }
  return { status: "created", draft };
}

export function ReceiptShortcutImportPage({ id, navigate }: { id: string; navigate: (path: string) => void }) {
  const receipts = useReceipts();
  const [attempt, setAttempt] = useState(0);
  const [working, setWorking] = useState(true);
  const [error, setError] = useState("");
  const [imported, setImported] = useState<PublicReceiptImport>();
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let active = true;
    setWorking(true); setError(""); setImported(undefined);
    getReceiptImport(id).then(async (value) => {
      if (!active) return;
      const result = await finalizeReceiptImport(value, {
        create: receipts.create,
        cleanup: () => deleteReceiptImport(value.id),
        cancelled: () => !active,
      });
      if (!active) return;
      if (result.status === "created") {
        navigate(`/receipts/${encodeURIComponent(result.draft.id)}`);
      } else if (result.status === "unusable") {
        setImported(result.imported);
        setError("The recognized text did not contain a usable merchant, total, or priced item.");
        setWorking(false);
      }
    }).catch((caught) => {
      if (!active) return;
      setError(importErrorMessage(caught)); setWorking(false);
    });
    return () => { active = false; };
  }, [attempt, id, navigate, receipts.create]);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  async function discard() {
    if (!imported) { navigate("/receipts/new"); return; }
    setWorking(true); setError("");
    try { await deleteReceiptImport(imported.id); navigate("/receipts"); }
    catch (caught) { setWorking(false); setError(importErrorMessage(caught)); }
  }

  return <div className="viewer-page"><header className="viewer-heading"><div><span>Apple Vision</span><h1>Import receipt</h1></div>
    <button className="icon-button" disabled={working} onClick={() => navigate("/receipts")} aria-label="Close"><X /></button></header>
    <section className="receipt-capture receipt-shortcut-import" aria-busy={working}>
      <FileWarning aria-hidden="true" />
      <h2>{working ? "Preparing your receipt" : "Receipt needs another look"}</h2>
      {working && <p role="status">Reading the recognized text and checking every amount…</p>}
      {error && <p className="receipt-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
      {imported && <details className="receipt-recognized-text"><summary>Show recognized text</summary>
        {imported.pages.map((page) => <pre key={page.page_index}>{page.text}</pre>)}</details>}
      {!working && <div className="receipt-import-actions">
        <button className="receipt-camera" onClick={() => setAttempt((value) => value + 1)}><RotateCcw />Retry import</button>
        <button className="secondary-button" onClick={() => void discard()}><Trash2 />{imported ? "Discard text" : "Start a new scan"}</button>
      </div>}
    </section>
  </div>;
}

function importErrorMessage(caught: unknown): string {
  if (caught instanceof MobileCommandApiError && caught.code === "RECEIPT_IMPORT_NOT_FOUND") {
    return "This receipt import expired or was already removed. Start a new scan.";
  }
  return caught instanceof Error ? caught.message : "The receipt could not be imported. Try again.";
}
