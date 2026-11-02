import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";

import { prepareReceiptPage, ReceiptImageStore } from "./receiptImages";
import { createReceiptOcrEngine } from "./receiptOcr";
import { parseReceiptPages } from "./receiptParser";
import { reconcileReceipt } from "./receiptMath";
import { useReceipts } from "./ReceiptProvider";
import type { ReceiptDraftV1, ReceiptOcrProgress } from "./types";

const imageStore = new ReceiptImageStore();

export function ReceiptCapturePage({ navigate }: { navigate: (path: string) => void }) {
  const receipts = useReceipts();
  const [progress, setProgress] = useState<ReceiptOcrProgress>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const engine = useRef(createReceiptOcrEngine(setProgress));
  useEffect(() => () => { controller.current?.abort(); void engine.current.terminate(); }, []);

  async function capture(files: FileList | null) {
    if (!files?.length || !receipts.available) return;
    if (files.length > 12) { setError("Choose no more than 12 receipt photos."); return; }
    setWorking(true); setError(""); controller.current = new AbortController();
    try {
      const pages = [];
      for (const [index, file] of [...files].entries()) {
        const page = await prepareReceiptPage(crypto.randomUUID(), file);
        pages.push(page);
      }
      const parsed = parseReceiptPages(await engine.current.recognize(pages, controller.current.signal));
      const current = await receipts.create(fromParsed(parsed, pages.length));
      for (const [index, page] of pages.entries()) {
        await imageStore.put(current.id, page.id, page.image as Blob, { order: index, rotation_degrees: 0, crop: null });
      }
      navigate(`/receipts/${encodeURIComponent(current.id)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Receipt capture failed.");
    } finally { setWorking(false); }
  }

  return <div className="viewer-page"><header className="viewer-heading"><div><span>On-device OCR</span><h1>Scan receipt</h1></div><button className="icon-button" onClick={() => navigate("/receipts")} aria-label="Close"><X /></button></header>
    <section className="receipt-capture"><Camera aria-hidden="true" /><h2>Photograph every page</h2><p>Overlap long receipts slightly. Photos and OCR stay in this browser.</p>
      <div className="receipt-source-actions">
        <label className="receipt-camera"><input type="file" accept="image/jpeg,image/png" capture="environment" multiple disabled={working} onChange={(event) => void capture(event.target.files)} />{working ? "Reading receipt…" : "Take photo"}</label>
        <label className="receipt-library"><input type="file" accept="image/jpeg,image/png" multiple disabled={working} onChange={(event) => void capture(event.target.files)} />Choose from photo library</label>
      </div>
      {progress && <p role="status">Page {progress.page_index + 1} of {progress.page_count} · {Math.round(progress.progress_basis_points / 100)}%</p>}
      {working && <button className="secondary-button" onClick={() => controller.current?.abort()}>Cancel</button>}
      {error && <p className="receipt-error" role="alert">{error}</p>}
    </section>
  </div>;
}

function fromParsed(parsed: ReturnType<typeof parseReceiptPages>, pageCount: number): ReceiptDraftV1 {
  const bases = parsed.lines.map((line) => ({ id: line.id, item_total_minor: line.item_total_minor,
    line_discount_minor: 0, taxable: true }));
  const total = parsed.total_minor?.value ?? parsed.lines.reduce((sum, line) => sum + line.item_total_minor, 0);
  let allocated = new Map<string, ReturnType<typeof reconcileReceipt>["lines"][number]>();
  try {
    allocated = new Map(reconcileReceipt({ lines: bases,
      receipt_discount_minor: parsed.discount_minor?.value ?? 0,
      tax_minor: parsed.tax_minor?.value ?? 0, tip_minor: parsed.tip_minor?.value ?? 0,
      fees_minor: parsed.fees_minor?.value ?? 0, total_minor: total })
      .lines.map((line) => [line.id, line]));
  } catch { /* review remains visibly unreconciled */ }
  return { contract: "receipt_draft/v1", status: "editing",
    merchant: parsed.merchant?.value ?? "", purchase_date: parsed.purchase_date?.value ?? null,
    currency: "USD", masked_payment_hint: null, page_count: pageCount,
    subtotal_minor: parsed.subtotal_minor?.value ?? bases.reduce((sum, line) => sum + line.item_total_minor, 0),
    discount_minor: parsed.discount_minor?.value ?? 0, tax_minor: parsed.tax_minor?.value ?? 0,
    tip_minor: parsed.tip_minor?.value ?? 0, fees_minor: parsed.fees_minor?.value ?? 0,
    total_minor: total, lines: parsed.lines.map((line, index) => ({ id: line.id, order: index,
      source_page: line.page_index, description: line.description, quantity: "1",
      unit_amount_minor: line.item_total_minor, item_total_minor: line.item_total_minor,
      line_discount_minor: allocated.get(line.id)?.receipt_discount_minor ?? 0,
      tax_minor: allocated.get(line.id)?.tax_minor ?? 0,
      tip_minor: allocated.get(line.id)?.tip_minor ?? 0,
      fees_minor: allocated.get(line.id)?.fees_minor ?? 0, taxable: true, owner: "Shared", category_id: null,
      subcategory_id: null, confidence_basis_points: line.confidence_basis_points,
      review_flags: [...line.review_flags,
        ...(parsed.overlap_groups.some((group) => group.observation_ids.includes(line.observation_id))
          ? ["possible_duplicate"] : [])] })) };
}
