import { useEffect, useRef, useState } from "react";
import { FileWarning, RotateCcw, Trash2, X } from "lucide-react";

import { MobileCommandApiError } from "../api";
import { draftFromParsedReceipt, draftFromValidatedReceipt, isUsableParsedReceipt,
  isUsableValidatedReceipt } from "./receiptDraftBuilder";
import { receiptPagesFromPlainText } from "./receiptPlainText";
import { parseReceiptPages } from "./receiptParser";
import { ReceiptModelComparison } from "./ReceiptModelComparison";
import { deleteReceiptImport, getReceiptImport, retryReceiptImport, selectReceiptModelResult,
  type PublicReceiptImport, type ReceiptModelSelection } from "./receiptShortcutApi";
import { useReceipts } from "./ReceiptProvider";
import type { ReceiptDraft, ReceiptDraftV1 } from "./types";

interface FinalizerDependencies {
  create: (draft: ReceiptDraftV1, idempotencyKey: string) => Promise<ReceiptDraft>;
  cleanup: () => Promise<void>;
  cancelled?: () => boolean;
}

export type ReceiptImportResult = { status: "created"; draft: ReceiptDraft }
  | { status: "comparing"; imported: PublicReceiptImport }
  | { status: "unusable"; imported: PublicReceiptImport }
  | { status: "refining"; imported: PublicReceiptImport }
  | { status: "failed"; imported: PublicReceiptImport }
  | { status: "cancelled" };

export async function finalizeReceiptImport(
  imported: PublicReceiptImport,
  dependencies: FinalizerDependencies,
): Promise<ReceiptImportResult> {
  if (imported.refinement && ["pending", "claimed"].includes(imported.refinement.status)) {
    return { status: "refining", imported };
  }
  if (imported.refinement?.status === "failed") return { status: "failed", imported };
  if (imported.shortcut_version === 3 && !imported.selection) {
    return { status: "comparing", imported };
  }
  if (imported.shortcut_version === 2 || imported.shortcut_version === 3) {
    if (imported.validation?.receipt && imported.validation.status !== "needs_refinement"
        && isUsableValidatedReceipt(imported.validation.receipt)) {
      if (dependencies.cancelled?.()) return { status: "cancelled" };
      const draft = await dependencies.create(draftFromValidatedReceipt(imported.validation.receipt,
        imported.pages.length, imported.validation.issues, sourceText(imported)), `shortcut-import-${imported.id}`);
      try { await dependencies.cleanup(); } catch { /* deterministic replay retries cleanup */ }
      return { status: "created", draft };
    }
    return { status: imported.validation ? "failed" : "unusable", imported };
  }
  const parsed = parseReceiptPages(receiptPagesFromPlainText(imported.pages));
  if (!isUsableParsedReceipt(parsed)) return { status: "unusable", imported };
  if (dependencies.cancelled?.()) return { status: "cancelled" };
  const draft = await dependencies.create(draftFromParsedReceipt(parsed, imported.pages.length, sourceText(imported)),
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
      } else if (["unusable", "refining", "failed", "comparing"].includes(result.status)) {
        const visible = result as Exclude<ReceiptImportResult, { status: "created" | "cancelled" }>;
        const waiting = visible.status === "refining";
        setImported(visible.imported);
        setError(visible.status === "comparing" ? ""
          : waiting
          ? "This receipt needs a closer look. Your Mac will refine it when it is awake; this page checks automatically."
          : visible.status === "failed"
            ? "The Mac could not safely reconcile this receipt. Retake clearer photos or discard this scan."
            : "The recognized text did not contain a usable merchant, total, or priced item.");
        setWorking(false);
      }
    }).catch((caught) => {
      if (!active) return;
      setError(importErrorMessage(caught)); setWorking(false);
    });
    return () => { active = false; };
  }, [attempt, id, navigate, receipts.create]);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (!imported?.refinement || !["pending", "claimed"].includes(imported.refinement.status)) return;
    const timer = window.setTimeout(() => setAttempt((value) => value + 1), 10_000);
    return () => window.clearTimeout(timer);
  }, [imported?.refinement]);

  async function discard() {
    if (!imported) { navigate("/receipts/new"); return; }
    setWorking(true); setError("");
    try { await deleteReceiptImport(imported.id); navigate("/receipts"); }
    catch (caught) { setWorking(false); setError(importErrorMessage(caught)); }
  }

  async function retry() {
    if (imported?.refinement?.status === "failed") {
      setWorking(true); setError("");
      try { await retryReceiptImport(imported.id); setAttempt((value) => value + 1); }
      catch (caught) { setWorking(false); setError(importErrorMessage(caught)); }
      return;
    }
    setAttempt((value) => value + 1);
  }

  async function reviewNow() {
    const validation = imported?.validation;
    if (!imported || !validation?.receipt || !isUsableValidatedReceipt(validation.receipt)) {
      setError("The phone result does not contain enough supported information to review safely.");
      return;
    }
    setWorking(true); setError("");
    try {
      const draft = await receipts.create(draftFromValidatedReceipt(validation.receipt,
        imported.pages.length, [...validation.issues, "manual_review_before_refinement"], sourceText(imported)),
      `shortcut-import-${imported.id}`);
      try { await deleteReceiptImport(imported.id); } catch { /* deterministic replay retries cleanup */ }
      navigate(`/receipts/${encodeURIComponent(draft.id)}`);
    } catch (caught) { setWorking(false); setError(importErrorMessage(caught)); }
  }

  async function selectModel(selection: ReceiptModelSelection) {
    if (!imported) return;
    setWorking(true); setError("");
    try {
      await selectReceiptModelResult(imported.id, selection);
      setAttempt((value) => value + 1);
    } catch (caught) { setWorking(false); setError(importErrorMessage(caught)); }
  }

  return <div className="viewer-page"><header className="viewer-heading"><div><span>Apple Vision</span><h1>Import receipt</h1></div>
    <button className="icon-button" disabled={working} onClick={() => navigate("/receipts")} aria-label="Close"><X /></button></header>
    {imported?.shortcut_version === 3 && imported.comparison && !imported.selection
      ? <ReceiptModelComparison comparison={imported.comparison} disabled={working}
        onSelect={(selection) => void selectModel(selection)} />
      : <section className="receipt-capture receipt-shortcut-import" aria-busy={working}>
      <FileWarning aria-hidden="true" />
      <h2>{working ? "Preparing your receipt" : "Receipt needs another look"}</h2>
      {working && <p role="status">Reading the recognized text and checking every amount…</p>}
      {error && <p className="receipt-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
      {imported && <details className="receipt-recognized-text"><summary>Show recognized text</summary>
        {imported.pages.map((page) => <pre key={page.page_index}>{page.text}</pre>)}</details>}
      {!working && <div className="receipt-import-actions">
        {imported?.validation?.receipt && isUsableValidatedReceipt(imported.validation.receipt)
          && <button className="receipt-camera" onClick={() => void reviewNow()}>Review phone result now</button>}
        <button className="secondary-button" onClick={() => void retry()}><RotateCcw />
          {imported?.refinement?.status === "failed" ? "Retry refinement" : "Refresh status"}</button>
        <button className="secondary-button" onClick={() => void discard()}><Trash2 />{imported ? "Discard text" : "Start a new scan"}</button>
      </div>}
    </section>}
  </div>;
}

function sourceText(imported: PublicReceiptImport): string {
  return imported.pages.map((page) => `--- PAGE ${page.page_index + 1} ---\n${page.text}`).join("\n");
}

function importErrorMessage(caught: unknown): string {
  if (caught instanceof MobileCommandApiError && caught.code === "RECEIPT_IMPORT_NOT_FOUND") {
    return "This receipt import expired or was already removed. Start a new scan.";
  }
  return caught instanceof Error ? caught.message : "The receipt could not be imported. Try again.";
}
