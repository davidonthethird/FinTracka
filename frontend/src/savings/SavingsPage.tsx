import { useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { api } from "../api";
import { formatMoney } from "../format";
import { ManualAssetDialog } from "./ManualAssetDialog";
import { activityLabel, savingsPath, type ManualAsset, type SavingsSummary } from "./model";

export function SavingsPage() {
  const [month, setMonth] = useState(() => new Date().toLocaleDateString("en-CA").slice(0, 7));
  const [owner, setOwner] = useState("");
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<SavingsSummary>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ManualAsset | "new">();
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setError("");
    api<SavingsSummary>(savingsPath(month, owner), { signal: controller.signal })
      .then(setData)
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load savings"); });
    return () => controller.abort();
  }, [month, owner, revision]);

  async function remove(asset: ManualAsset) {
    if (!window.confirm(`Remove ${asset.title} from Savings? Its audit history will be retained.`)) return;
    try {
      await api(`/savings/assets/${asset.id}?expected_updated_at=${encodeURIComponent(asset.updated_at)}`, { method: "DELETE" });
      setRevision((value) => value + 1);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to remove asset"); }
  }

  const history = data?.accounts.flatMap((account) => account.history.map((point) => ({ date: point.observed_at.slice(0, 10), value: point.current_minor, account: account.name }))) || [];
  return <div className="page savings-page">
    <header className="page-title"><div><p className="eyebrow">FinTracka</p><h1>Savings</h1></div><p>Connected savings and manually tracked assets</p></header>
    <section className="savings-toolbar instrument-panel" aria-label="Savings controls"><label>Month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><label>Owner<select aria-label="Savings owner" value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">Everyone</option><option>David</option><option>Ariela</option><option>Shared</option></select></label><button onClick={() => setEditing("new")}>Add manual asset</button></section>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!data ? !error && <div className="page-state">Reading savings…</div> : <>
      <section className="savings-total" data-testid="savings-combined"><span>Combined savings and assets</span><strong>{formatMoney(data.combined_total_minor)}</strong><small>{owner || "Household"} · USD</small></section>
      <section className="metric-line savings-metrics"><div className="metric"><span>Connected savings</span><strong>{formatMoney(data.connected_total_minor)}</strong></div><div className="metric"><span>Manual cash savings</span><strong>{formatMoney(data.manual_savings_minor)}</strong></div><div className="metric"><span>Investments</span><strong>{formatMoney(data.investments_minor)}</strong></div><div className="metric"><span>Other assets</span><strong>{formatMoney(data.other_assets_minor)}</strong></div></section>
      <div className="two-column savings-columns">
        <section className="instrument-panel"><div className="section-heading"><div><p className="eyebrow">Bank data</p><h2>Connected accounts</h2></div><span>{data.accounts.length} included</span></div>{data.accounts.length ? <div className="savings-list">{data.accounts.map((account) => <div key={account.account_id}><span><strong>{account.name}</strong><small>{account.owner} · {account.history.length} balance observation{account.history.length === 1 ? "" : "s"}</small></span><b>{formatMoney(account.balance_minor, account.currency)}</b></div>)}</div> : <div className="empty"><strong>No connected savings accounts</strong><p>Mark an account for Savings from its account settings.</p></div>}</section>
        <section className="instrument-panel"><div className="section-heading"><div><p className="eyebrow">Your valuations</p><h2>Manually tracked assets</h2></div><span>{data.manual_assets.length} active</span></div>{data.manual_assets.length ? <div className="savings-list manual-assets">{data.manual_assets.map((asset) => <div key={asset.id}><span><strong>{asset.title}</strong><small>{asset.kind.replace("_", " ")} · {asset.owner} · valued {asset.as_of_date}</small></span><b>{formatMoney(asset.current_value_minor, asset.currency)}</b><span className="row-actions"><button className="text-button" aria-label={`Edit ${asset.title}`} onClick={() => setEditing(asset)}>Edit</button><button className="text-button destructive" aria-label={`Remove ${asset.title}`} onClick={() => remove(asset)}>Remove</button></span></div>)}</div> : <div className="empty"><strong>No manually tracked assets</strong><p>Add cash savings, investments, or other assets that are not connected to a bank.</p></div>}</section>
      </div>
      <section className="metric-line compact savings-activity-metrics"><div className="metric teal"><span>Contributions this month</span><strong>{formatMoney(data.contributions_minor)}</strong></div><div className="metric amber"><span>Withdrawals this month</span><strong>{formatMoney(data.withdrawals_minor)}</strong></div><div className="metric"><span>Earnings this month</span><strong>{formatMoney(data.earnings_minor)}</strong></div></section>
      <div className="two-column savings-columns">
        <section className="instrument-panel"><div className="section-heading"><h2>Balance history</h2><span>Locally retained observations</span></div>{history.length ? <div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={history}><CartesianGrid vertical={false} stroke="var(--line)"/><XAxis dataKey="date" tickLine={false}/><YAxis hide/><Tooltip formatter={(value) => formatMoney(Number(value))}/><Area type="monotone" dataKey="value" stroke="var(--teal)" fill="var(--teal-soft)"/></AreaChart></ResponsiveContainer></div> : <div className="empty"><strong>No balance history yet</strong><p>Each sync adds local observations; they are not discarded when Plaid history ages.</p></div>}</section>
        <section className="instrument-panel"><div className="section-heading"><h2>Monthly activity</h2><span>Planning remains separate</span></div>{data.activity.length ? <div className="savings-list">{data.activity.map((entry) => <div key={entry.transaction_id}><span><strong>{entry.title}</strong><small>{entry.local_date} · {entry.owner}</small></span><i className={`activity-kind ${entry.kind}`}>{activityLabel(entry.kind)}</i><b>{formatMoney(entry.amount_minor)}</b></div>)}</div> : <div className="empty"><strong>No savings activity this month</strong><p>Contributions, withdrawals, and earnings will appear after sync.</p></div>}</section>
      </div>
    </>}
    {editing && <ManualAssetDialog asset={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); setRevision((value) => value + 1); }} />}
  </div>;
}
