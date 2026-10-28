import { useEffect, useState } from "react";
import { BarChart3, Landmark, List, PiggyBank, WalletCards } from "lucide-react";
import { loadRemoteData, type ViewerStatus } from "./api";
import type { RemoteSnapshot } from "./model";
import { OverviewPage } from "./OverviewPage";
import { PlanningPage } from "./PlanningPage";
import { ReportsPage } from "./ReportsPage";
import { SavingsPage } from "./SavingsPage";
import { TransactionsPage } from "./TransactionsPage";

const navigation = [
  ["/", "Overview", Landmark],
  ["/transactions", "Transactions", List],
  ["/planning", "Planning", WalletCards],
  ["/savings", "Savings", PiggyBank],
  ["/reports", "Reports", BarChart3],
] as const;

export function ViewerApp() {
  const [route, setRoute] = useState(window.location.pathname);
  const [snapshot, setSnapshot] = useState<RemoteSnapshot>();
  const [status, setStatus] = useState<ViewerStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    loadRemoteData().then((data) => {
      if (!active) return;
      setSnapshot(data.snapshot); setStatus(data.status); setError("");
    }).catch((caught) => {
      if (!active) return;
      setSnapshot(undefined); setStatus(undefined);
      setError(caught instanceof Error ? caught.message : "The private viewer could not load.");
    });
    return () => { active = false; setSnapshot(undefined); };
  }, []);
  useEffect(() => {
    const navigate = () => setRoute(window.location.pathname);
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);
  function navigate(path: string) {
    window.history.pushState(null, "", path);
    setRoute(path);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  if (error) return <main className="viewer-state"><span className="viewer-mark">F</span><h1>Viewer unavailable</h1><p>{error}</p><button onClick={() => window.location.reload()}>Try again</button></main>;
  if (!snapshot) return <main className="viewer-state"><span className="viewer-mark">F</span><h1>Opening your private ledger</h1><p>Reading the latest published snapshot…</p></main>;
  return <div className="remote-shell">
    <header className="viewer-topbar"><button className="viewer-brand" onClick={() => navigate("/")}><span>F</span><strong>FinTracka</strong><small>Remote viewer</small></button><a href="/cdn-cgi/access/logout">Sign out</a></header>
    {status?.stale && <div className="stale-banner"><strong>Data may be out of date.</strong> Your Mac has not published a fresh snapshot recently.</div>}
    <main className="viewer-workspace">
      {route === "/" && <OverviewPage snapshot={snapshot} publishedAt={status?.published_at} />}
      {route === "/transactions" && <TransactionsPage snapshot={snapshot} />}
      {route === "/planning" && <PlanningPage snapshot={snapshot} />}
      {route === "/savings" && <SavingsPage snapshot={snapshot} />}
      {route === "/reports" && <ReportsPage snapshot={snapshot} />}
      {!navigation.some(([path]) => path === route) && <Placeholder title="Page not found" text="Choose a section below." />}
    </main>
    <nav className="viewer-nav" aria-label="Viewer sections">{navigation.map(([path, label, Icon]) => <button key={path} className={route === path ? "active" : ""} onClick={() => navigate(path)}><Icon aria-hidden="true" /><span>{label}</span></button>)}</nav>
  </div>;
}

function Placeholder({ title, text }: { title: string; text: string }) {
  return <div className="viewer-page"><header className="viewer-heading"><div><span>Read-only</span><h1>{title}</h1></div></header><div className="viewer-empty"><h2>{title} is loading next</h2><p>{text}</p></div></div>;
}
