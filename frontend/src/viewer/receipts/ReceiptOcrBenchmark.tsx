import { useEffect, useRef, useState } from "react";

import { prepareReceiptPage } from "./receiptImages";
import { createReceiptOcrEngine } from "./receiptOcr";
import { parseReceiptPages } from "./receiptParser";
import type { OcrReceiptPage, ReceiptOcrProgress } from "./types";

export function ReceiptOcrBenchmark() {
  const [progress, setProgress] = useState<ReceiptOcrProgress>();
  const engine = useRef(createReceiptOcrEngine(setProgress));
  const [results, setResults] = useState<OcrReceiptPage[]>([]);
  const [duration, setDuration] = useState<number>();
  const [error, setError] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => { controller.current?.abort(); void engine.current.terminate(); }, []);

  async function run(pageCount: number) {
    controller.current?.abort();
    controller.current = new AbortController();
    setError(""); setResults([]); setDuration(undefined);
    const started = performance.now();
    try {
      const pages = await Promise.all(Array.from({ length: pageCount }, async (_, index) => {
        const response = await fetch(`/receipt-fixtures/${index % 2 === 0 ? "one-page" : "overlap-page"}.png`);
        if (!response.ok) throw new Error("Synthetic receipt fixture is unavailable");
        return prepareReceiptPage(`synthetic-${index + 1}`, await response.blob());
      }));
      setResults(await engine.current.recognize(pages, controller.current.signal));
      setDuration(performance.now() - started);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OCR benchmark failed");
    }
  }

  async function runFiles(files: FileList | null) {
    if (!files?.length) return;
    controller.current?.abort();
    controller.current = new AbortController();
    setError(""); setResults([]); setDuration(undefined);
    const started = performance.now();
    try {
      const pages = await Promise.all([...files].map((file, index) =>
        prepareReceiptPage(`private-${index + 1}`, file)));
      setResults(await engine.current.recognize(pages, controller.current.signal));
      setDuration(performance.now() - started);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OCR benchmark failed");
    }
  }

  return <main style={{ margin: "0 auto", maxWidth: 720, padding: 24 }}>
    <h1>Private receipt OCR benchmark</h1>
    <p>Development-only synthetic images. Nothing is uploaded or saved.</p>
    <div style={{ display: "flex", gap: 12 }}>
      <button onClick={() => run(1)}>Run one page</button>
      <button onClick={() => run(6)}>Run six pages</button>
      <button onClick={() => controller.current?.abort()}>Cancel</button>
    </div>
    <label>Private local samples <input id="private-receipt-files" type="file" accept="image/*" multiple
      onChange={(event) => void runFiles(event.currentTarget.files)} /></label>
    {progress && <p role="status">Page {progress.page_index + 1}/{progress.page_count}: {progress.status} {Math.round(progress.progress_basis_points / 100)}%</p>}
    {duration !== undefined && <p><strong>{results.length} pages in {(duration / 1_000).toFixed(1)} seconds</strong></p>}
    {error && <p role="alert">{error}</p>}
    {results.length > 0 && <pre id="parsed-receipt" style={{ whiteSpace: "pre-wrap" }}>
      {JSON.stringify(parseReceiptPages(results), null, 2)}
    </pre>}
    {results.length > 0 && <pre id="ocr-observations" style={{ whiteSpace: "pre-wrap" }}>
      {JSON.stringify(results, null, 2)}
    </pre>}
    {results.map((result) => <pre key={result.id} style={{ whiteSpace: "pre-wrap" }}>{result.text}</pre>)}
  </main>;
}
