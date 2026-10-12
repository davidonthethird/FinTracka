import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { bootstrapSession } from "./api";
import "./styles.css";

function Root() {
  const [state, setState] = useState<{ ready: boolean; error?: string }>({ ready: false });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    bootstrapSession().then(() => setState({ ready: true })).catch((error: Error) => setState({ ready: false, error: error.message }));
  }, []);
  if (state.error) {
    return <main className="access-state"><p className="eyebrow">Local access required</p><h1>FinTracka is locked</h1><p>{state.error}</p></main>;
  }
  if (!state.ready) return <main className="access-state"><p>Opening your ledger…</p></main>;
  return <BrowserRouter><App /></BrowserRouter>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
