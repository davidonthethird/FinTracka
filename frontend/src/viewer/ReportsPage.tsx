import { useEffect, useMemo, useState } from "react";
import { formatMoney } from "../format";
import { CategoryDrawer } from "./CategoryDrawer";
import { snapshotMonths, type RemoteSnapshot, type RemoteTransaction } from "./model";
import { ReportFlow, type FlowGraph, type FlowSelection } from "./ReportFlow";

type ReportCategory = { category_id: string | null; category: string; amount_minor: number };
type Report = {
  cash_flow: { income_minor: number; spending_minor: number; net_minor: number };
  spending_by_category: ReportCategory[];
  spending_by_owner: { owner: string; amount_minor: number }[];
  cash_flow_paths?: FlowGraph;
};
type ReportSelection = ReportCategory & { entryIds?: string[]; subcategoryId?: string | null; owner?: FlowSelection["owner"] };

export function spendingPercentage(amount: number, categories: ReportCategory[]): string {
  const total = categories.reduce((sum, item) => sum + Math.max(item.amount_minor, 0), 0);
  return total ? (amount / total * 100).toFixed(1) : "0.0";
}

export function selectionPercentage(
  selection: ReportSelection,
  categories: ReportCategory[],
  owners: { owner: string; amount_minor: number }[],
): { value: string; context: string } {
  if (selection.owner) {
    const total = owners.find((item) => item.owner === selection.owner)?.amount_minor ?? 0;
    return { value: total ? (selection.amount_minor / total * 100).toFixed(1) : "0.0", context: `${selection.owner}’s spending` };
  }
  return { value: spendingPercentage(selection.amount_minor, categories), context: "household spending" };
}

export function selectedFlowTransactions(selection: ReportSelection, graph: FlowGraph | undefined, transactions: RemoteTransaction[]): RemoteTransaction[] {
  if (!selection.entryIds || !graph?.entries) return transactions.filter((item) => item.category_id === selection.category_id);
  const entries = new Map(graph.entries.map((entry) => [entry.id, entry]));
  const bases = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  return selection.entryIds.flatMap((id) => {
    const entry = entries.get(id);
    if (!entry) return [];
    const base = bases.get(entry.transaction_id);
    return [{
      ...(base ?? { account_name: "Published account", account_type: "", account_subtype: null, account_mask: null, institution_name: null, pending: false, manual_cash: false, is_cash_withdrawal: false, updated_at: "" }),
      id: entry.id, local_date: entry.local_date, amount_minor: entry.amount_minor, currency: entry.currency,
      description: entry.description, merchant: entry.merchant, category_id: entry.category_id, category: entry.category,
      subcategory_id: Object.hasOwn(entry, "subcategory_id") ? entry.subcategory_id ?? null : base?.subcategory_id ?? null,
      subcategory: Object.hasOwn(entry, "subcategory") ? entry.subcategory ?? null : base?.subcategory ?? null,
      spending_owner: entry.spending_owner as RemoteTransaction["spending_owner"],
    }];
  });
}

export function ReportsPage({ snapshot }: { snapshot: RemoteSnapshot }) {
  const months = snapshotMonths(snapshot);
  const [month, setMonth] = useState(months[0]);
  const [selected, setSelected] = useState<ReportSelection>();
  useEffect(() => setSelected(undefined), [snapshot]);
  const report = snapshot.reports[`${month}|owner=Combined`] as unknown as Report | undefined;
  const transactions = useMemo(() => snapshot.transactions.filter((item) => item.local_date.startsWith(month)), [snapshot, month]);
  if (!report) return <div className="viewer-empty"><h2>Reports are not available for this month</h2></div>;
  const categoryMax = Math.max(1, ...report.spending_by_category.map((item) => item.amount_minor));
  const ownerTotal = report.spending_by_owner.reduce((sum, item) => sum + item.amount_minor, 0);
  const selectedShare = selected ? selectionPercentage(selected, report.spending_by_category, report.spending_by_owner) : undefined;
  return <div className="viewer-page">
    <header className="viewer-heading"><div><span>Income and outflow</span><h1>Reports</h1></div><label className="month-select">Month<select value={month} onChange={(event) => { setSelected(undefined); setMonth(event.target.value); }}>{months.map((value) => <option key={value}>{value}</option>)}</select></label></header>
    <section className="report-summary"><div><span>Income</span><strong className="positive">{formatMoney(report.cash_flow.income_minor)}</strong></div><div><span>Spending</span><strong className="negative">{formatMoney(report.cash_flow.spending_minor)}</strong></div><div><span>Net</span><strong className={report.cash_flow.net_minor >= 0 ? "positive" : "negative"}>{formatMoney(report.cash_flow.net_minor)}</strong></div></section>
    <section className="viewer-section report-flow-section"><div className="section-line"><h2>Money flow</h2><span>Tap any part to inspect it</span></div><ReportFlow key={month} report={report.cash_flow_paths} expectedCategories={report.spending_by_category} onCategory={(item: FlowSelection) => setSelected({ category_id: item.categoryId, category: item.label, amount_minor: item.amountMinor, entryIds: item.entryIds, subcategoryId: item.subcategoryId, owner: item.owner })} /></section>
    <div className="report-columns"><section className="viewer-section"><div className="section-line"><h2>By category</h2><span>{report.spending_by_category.length}</span></div><div className="report-bars">{report.spending_by_category.map((item) => <button key={item.category_id ?? item.category} onClick={() => setSelected(item)}><span><strong>{item.category}</strong><i><b style={{ width: `${item.amount_minor / categoryMax * 100}%` }} /></i></span><b>{formatMoney(item.amount_minor)}</b></button>)}</div></section><section className="viewer-section"><div className="section-line"><h2>By person</h2><span>Owner share</span></div><div className="owner-shares">{report.spending_by_owner.map((item) => <div key={item.owner}><i className={item.owner.toLowerCase()} style={{ width: `${ownerTotal ? item.amount_minor / ownerTotal * 100 : 0}%` }} /><span><strong>{item.owner}</strong><small>{ownerTotal ? (item.amount_minor / ownerTotal * 100).toFixed(1) : "0.0"}%</small></span><b>{formatMoney(item.amount_minor)}</b></div>)}</div></section></div>
    {selected && selectedShare && <CategoryDrawer title={selected.category} subtitle={`${month} report · ${selectedShare.value}% of ${selectedShare.context}`} metrics={[{ label: "Total spending", value: selected.amount_minor, tone: "negative" }]} transactions={selectedFlowTransactions(selected, report.cash_flow_paths, transactions)} onClose={() => setSelected(undefined)} />}
  </div>;
}
