import { X } from "lucide-react";
import { formatMoney } from "../format";
import type { RemoteTransaction } from "./model";

export interface DrawerMetric { label: string; value: number; tone?: string }
export interface DrawerBreakdown { label: string; amount_minor: number }

export function CategoryDrawer({
  title, subtitle, metrics, breakdown, trend, transactions, onClose,
}: {
  title: string;
  subtitle: string;
  metrics: DrawerMetric[];
  breakdown?: DrawerBreakdown[];
  trend?: { month: string; amount_minor: number }[];
  transactions: RemoteTransaction[];
  onClose: () => void;
}) {
  const trendMax = Math.max(1, ...(trend ?? []).map((item) => item.amount_minor));
  return <div className="viewer-drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="viewer-drawer category-detail" role="dialog" aria-modal="true" aria-labelledby="category-title">
      <button className="drawer-close" aria-label="Close category details" onClick={onClose}><X /></button>
      <span className="drawer-date">{subtitle}</span><h2 id="category-title">{title}</h2>
      <div className="drawer-metrics">{metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong className={metric.tone}>{formatMoney(metric.value)}</strong></div>)}</div>
      {trend && trend.length > 0 && <section className="drawer-section"><h3>Monthly trend</h3><div className="mini-trend" aria-label={`${title} monthly spending trend`}>{trend.map((item) => <div key={item.month}><span style={{ height: `${Math.max(3, item.amount_minor / trendMax * 100)}%` }} /><small>{item.month.slice(5)}</small></div>)}</div></section>}
      {breakdown && breakdown.length > 0 && <section className="drawer-section"><h3>Breakdown</h3><div className="drawer-breakdown">{breakdown.map((item) => <div key={item.label}><span>{item.label}</span><strong>{formatMoney(item.amount_minor)}</strong></div>)}</div></section>}
      <section className="drawer-section"><h3>This month’s transactions <span>{transactions.length}</span></h3>{transactions.length ? <div className="drawer-transactions">{transactions.map((item) => <div key={item.id}><span><strong>{item.merchant || item.description}</strong><small>{item.local_date} · {item.account_name}{item.spending_owner ? ` · ${item.spending_owner}` : ""}</small></span><b className={item.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(item.amount_minor, item.currency)}</b></div>)}</div> : <p className="drawer-empty">No transactions in the published detail window.</p>}</section>
    </aside>
  </div>;
}
