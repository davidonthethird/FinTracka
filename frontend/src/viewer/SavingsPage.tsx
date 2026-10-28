import { useState } from "react";
import { formatMoney } from "../format";
import { SavingsGoalDrawer, type SavingsGoal } from "./SavingsGoalDrawer";
import { snapshotMonths, type RemoteSnapshot } from "./model";

type SavingsView = {
  combined_total_minor: number; connected_total_minor: number; manual_savings_minor: number;
  investments_minor: number; other_assets_minor: number; contributions_minor: number;
  withdrawals_minor: number; earnings_minor: number;
  accounts: { account_id: string; name: string; owner: string; balance_minor: number; pool: string | null }[];
  manual_assets: { id: string; title: string; kind: string; owner: string; current_value_minor: number; savings_pool: string | null }[];
  activity: { transaction_id: string; local_date: string; title: string; kind: string; amount_minor: number; owner: string }[];
  goal_ledger: { regular_minor: number; retirement_minor: number; combined_minor: number; goals: SavingsGoal[] } | null;
};

export function SavingsPage({ snapshot }: { snapshot: RemoteSnapshot }) {
  const month = snapshotMonths(snapshot)[0];
  const [owner, setOwner] = useState("Combined");
  const [showSplits, setShowSplits] = useState(false);
  const [goal, setGoal] = useState<SavingsGoal>();
  const savings = snapshot.savings[`${month}|owner=${owner}`] as unknown as SavingsView | undefined;
  if (!savings) return <div className="viewer-empty"><h2>Savings is not available in this snapshot</h2></div>;
  const goals = savings.goal_ledger?.goals ?? [];
  const regular = savings.goal_ledger?.regular_minor ?? savings.connected_total_minor + savings.manual_savings_minor;
  const retirement = savings.goal_ledger?.retirement_minor ?? savings.investments_minor;
  return <div className="viewer-page">
    <header className="viewer-heading"><div><span>Long-term position</span><h1>Savings</h1></div><strong>{month}</strong></header>
    <section className="view-controls savings-controls"><div className="owner-tabs" aria-label="Savings owner">{["Combined", "David", "Ariela", "Shared"].map((name) => <button key={name} className={owner === name ? "active" : ""} onClick={() => setOwner(name)}>{name}</button>)}</div><button className="split-toggle" onClick={() => setShowSplits(!showSplits)}>{showSplits ? "Hide splits" : "Show splits"}</button></section>
    <section className="savings-hero"><div className="savings-ring" style={{ "--regular-share": `${savings.combined_total_minor ? regular / savings.combined_total_minor * 100 : 0}%` } as React.CSSProperties}><span><small>Total savings</small><strong>{formatMoney(savings.combined_total_minor)}</strong></span></div><div className="pool-legend"><div><i className="regular" /><span>Regular savings<strong>{formatMoney(regular)}</strong></span></div><div><i className="retirement" /><span>Retirement<strong>{formatMoney(retirement)}</strong></span></div></div></section>
    {showSplits && <section className="viewer-section"><div className="section-line"><h2>Account and asset splits</h2><span>{owner}</span></div><div className="drawer-breakdown">{savings.accounts.map((item) => <div key={item.account_id}><span>{item.name} · {item.owner}</span><strong>{formatMoney(item.balance_minor)}</strong></div>)}{savings.manual_assets.map((item) => <div key={item.id}><span>{item.title} · {item.owner}</span><strong>{formatMoney(item.current_value_minor)}</strong></div>)}</div></section>}
    <section className="viewer-section"><div className="section-line"><h2>Goals</h2><span>Monthly and overall</span></div>{goals.length ? <div className="goal-list">{goals.map((item) => <button key={item.goal_id} onClick={() => setGoal(item)}><span><strong>{item.name}</strong><small>{formatMoney(item.monthly_saved_minor)} of {formatMoney(item.monthly_target_minor)} this month</small></span><span className="goal-progress"><i style={{ width: `${Math.min(100, (item.monthly_funded_basis_points ?? 0) / 100)}%` }} /></span><b>{formatMoney(item.balance_minor)}</b></button>)}</div> : <div className="viewer-empty compact"><h2>No savings goals in this snapshot</h2><p>The balances below are still current.</p></div>}</section>
    <section className="viewer-section"><div className="section-line"><h2>Monthly activity</h2><span>{savings.activity.length} entries</span></div><div className="activity-list">{savings.activity.map((item) => <div key={item.transaction_id}><span><strong>{item.title}</strong><small>{item.local_date} · {item.kind} · {item.owner}</small></span><b className={item.kind === "withdrawal" || item.kind === "expense" ? "negative" : "positive"}>{formatMoney(item.amount_minor)}</b></div>)}</div></section>
    {goal && <SavingsGoalDrawer goal={goal} onClose={() => setGoal(undefined)} />}
  </div>;
}
