import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";

import { prepareReceiptPage, ReceiptImageStore } from "./receiptImages";
import { createReceiptOcrEngine } from "./receiptOcr";
import { draftFromParsedReceipt } from "./receiptDraftBuilder";
import { parseReceiptPages } from "./receiptParser";
import { useReceipts } from "./ReceiptProvider";
import type { ReceiptOcrProgress } from "./types";

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
      const current = await receipts.create(draftFromParsedReceipt(parsed, pages.length));
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
