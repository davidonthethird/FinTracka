import { useMemo, useState } from "react";
import { formatMoney } from "../format";
import { CategoryDrawer } from "./CategoryDrawer";
import { snapshotMonths, type RemoteSnapshot } from "./model";
import { ReportFlow, type FlowGraph } from "./ReportFlow";

type ReportCategory = { category_id: string | null; category: string; amount_minor: number };
type Report = {
  cash_flow: { income_minor: number; spending_minor: number; net_minor: number };
  spending_by_category: ReportCategory[];
  spending_by_owner: { owner: string; amount_minor: number }[];
  cash_flow_paths?: FlowGraph;
};

export function ReportsPage({ snapshot }: { snapshot: RemoteSnapshot }) {
  const months = snapshotMonths(snapshot);
  const [month, setMonth] = useState(months[0]);
  const [selected, setSelected] = useState<ReportCategory>();
  const report = snapshot.reports[`${month}|owner=Combined`] as unknown as Report | undefined;
  const transactions = useMemo(() => snapshot.transactions.filter((item) => item.local_date.startsWith(month)), [snapshot, month]);
  if (!report) return <div className="viewer-empty"><h2>Reports are not available for this month</h2></div>;
  const categoryMax = Math.max(1, ...report.spending_by_category.map((item) => item.amount_minor));
  const ownerTotal = report.spending_by_owner.reduce((sum, item) => sum + item.amount_minor, 0);
  return <div className="viewer-page">
    <header className="viewer-heading"><div><span>Income and outflow</span><h1>Reports</h1></div><label className="month-select">Month<select value={month} onChange={(event) => setMonth(event.target.value)}>{months.map((value) => <option key={value}>{value}</option>)}</select></label></header>
    <section className="report-summary"><div><span>Income</span><strong className="positive">{formatMoney(report.cash_flow.income_minor)}</strong></div><div><span>Spending</span><strong className="negative">{formatMoney(report.cash_flow.spending_minor)}</strong></div><div><span>Net</span><strong className={report.cash_flow.net_minor >= 0 ? "positive" : "negative"}>{formatMoney(report.cash_flow.net_minor)}</strong></div></section>
    <section className="viewer-section report-flow-section"><div className="section-line"><h2>Money flow</h2><span>Tap any part to inspect it</span></div><ReportFlow report={report.cash_flow_paths} onCategory={(categoryId, label) => setSelected(report.spending_by_category.find((item) => item.category_id === categoryId && (categoryId !== null || item.category === label)))} /></section>
    <div className="report-columns"><section className="viewer-section"><div className="section-line"><h2>By category</h2><span>{report.spending_by_category.length}</span></div><div className="report-bars">{report.spending_by_category.map((item) => <button key={item.category_id ?? item.category} onClick={() => setSelected(item)}><span><strong>{item.category}</strong><i><b style={{ width: `${item.amount_minor / categoryMax * 100}%` }} /></i></span><b>{formatMoney(item.amount_minor)}</b></button>)}</div></section><section className="viewer-section"><div className="section-line"><h2>By person</h2><span>Owner share</span></div><div className="owner-shares">{report.spending_by_owner.map((item) => <div key={item.owner}><i className={item.owner.toLowerCase()} style={{ width: `${ownerTotal ? item.amount_minor / ownerTotal * 100 : 0}%` }} /><span><strong>{item.owner}</strong><small>{ownerTotal ? (item.amount_minor / ownerTotal * 100).toFixed(1) : "0.0"}%</small></span><b>{formatMoney(item.amount_minor)}</b></div>)}</div></section></div>
    {selected && <CategoryDrawer title={selected.category} subtitle={`${month} report · ${report.cash_flow.spending_minor ? (selected.amount_minor / report.cash_flow.spending_minor * 100).toFixed(1) : "0.0"}% of spending`} metrics={[{ label: "Total spending", value: selected.amount_minor, tone: "negative" }]} transactions={transactions.filter((item) => item.category_id === selected.category_id)} onClose={() => setSelected(undefined)} />}
  </div>;
}
