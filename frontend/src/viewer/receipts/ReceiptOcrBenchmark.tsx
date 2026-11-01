import { useEffect, useRef, useState } from "react";

import { createReceiptOcrEngine } from "./receiptOcr";
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
      const pages = Array.from({ length: pageCount }, (_, index) => ({
        id: `synthetic-${index + 1}`,
        image: `/receipt-fixtures/${index % 2 === 0 ? "one-page" : "overlap-page"}.svg`,
      }));
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
    {progress && <p role="status">Page {progress.page_index + 1}/{progress.page_count}: {progress.status} {Math.round(progress.progress_basis_points / 100)}%</p>}
    {duration !== undefined && <p><strong>{results.length} pages in {(duration / 1_000).toFixed(1)} seconds</strong></p>}
    {error && <p role="alert">{error}</p>}
    {results.map((result) => <pre key={result.id} style={{ whiteSpace: "pre-wrap" }}>{result.text}</pre>)}
  </main>;
}
