import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ViewerApp } from "./ViewerApp";
import { ReceiptOcrBenchmark } from "./receipts/ReceiptOcrBenchmark";
import "./viewer.css";

const Root = import.meta.env.DEV && (window.location.pathname === "/__receipt-ocr-benchmark"
  || new URLSearchParams(window.location.search).has("receipt-ocr-benchmark"))
  ? ReceiptOcrBenchmark
  : ViewerApp;

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
