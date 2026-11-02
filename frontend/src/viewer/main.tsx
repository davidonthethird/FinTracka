import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ViewerApp } from "./ViewerApp";
import "./viewer.css";

const benchmark = import.meta.env.DEV && (window.location.pathname === "/__receipt-ocr-benchmark"
  || new URLSearchParams(window.location.search).has("receipt-ocr-benchmark"));
const root = createRoot(document.getElementById("root")!);

if (benchmark) {
  void import("./receipts/ReceiptOcrBenchmark").then(({ ReceiptOcrBenchmark }) => {
    root.render(<StrictMode><ReceiptOcrBenchmark /></StrictMode>);
  });
} else {
  root.render(<StrictMode><ViewerApp /></StrictMode>);
}
