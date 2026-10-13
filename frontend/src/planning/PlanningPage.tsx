import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api";
import { formatMoney } from "../format";
import { CategoryDrawer } from "./CategoryDrawer";
import { PlanningFlow } from "./PlanningFlow";
import { planningPath, type PlanningCategory, type PlanningIncome, type PlanningSnapshot } from "./model";

type Transaction = { id: string; local_date: string; description: string; merchant?: string; amount_minor: number; currency: string };

export function PlanningPage() {
  const [month, setMonth] = useState(() => new Date().toLocaleDateString("en-CA").slice(0, 7));
  const [averageMonths, setAverageMonths] = useState(12);
  const [owner, setOwner] = useState("");
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<PlanningSnapshot>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PlanningCategory>();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [returnFocus, setReturnFocus] = useState<HTMLButtonElement | null>(null);
  const [editingIncome, setEditingIncome] = useState<PlanningIncome>();
  const incomeTitle = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    setError("");
    try { setData(await api<PlanningSnapshot>(planningPath(month, averageMonths, owner))); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to load planning"); }
  }, [month, averageMonths, owner, revision]);
  useEffect(() => { void load(); }, [load]);

  async function openCategory(category: PlanningCategory, trigger: HTMLButtonElement) {
    setReturnFocus(trigger); setSelected(category);
    try {
      const result = await api<{ items: Transaction[] }>(`/transactions?category_id=${encodeURIComponent(category.category_id)}&limit=200`);
      setTransactions(result.items.filter((item) => item.local_date.startsWith(month)));
    } catch { setTransactions([]); }
  }
  async function saveTarget(amountMinor: number, oneMonth: boolean) {
    if (!selected) return;
    await api(oneMonth ? `/planning/targets/${selected.category_id}/overrides/${month}` : `/planning/targets/${selected.category_id}`, {
      method: "PUT",
      body: JSON.stringify(oneMonth ? { amount_minor: amountMinor } : { effective_month: month, amount_minor: amountMinor }),
    });
    setSelected(undefined); setRevision((value) => value + 1);
  }
  async function saveIncome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = { title: form.get("title"), income_type: form.get("type"), amount_minor: Math.round(Number(form.get("amount")) * 100), effective_month: month };
    try {
      if (editingIncome) {
        await api(`/planning/income-sources/${editingIncome.source_id}`, { method: "PATCH", body: JSON.stringify({ ...payload, expected_updated_at: editingIncome.updated_at, active: true }) });
      } else {
        await api("/planning/income-sources", { method: "POST", body: JSON.stringify(payload) });
      }
      formElement.reset(); setEditingIncome(undefined); setRevision((value) => value + 1);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save income source"); }
  }
  useEffect(() => { if (editingIncome) incomeTitle.current?.focus(); }, [editingIncome]);

  return <div className="page planning-page">
    <header className="page-title"><div><p className="eyebrow">FinTracka</p><h1>Planning</h1></div><p>Usual spending, your targets, and this month’s actuals</p></header>
    <section className="planning-toolbar" aria-label="Planning controls">
      <label>Month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
      <label className="window-control">Average window: <strong>{averageMonths} months</strong><input aria-label="Average window" type="range" min="1" max="12" value={averageMonths} onChange={(event) => setAverageMonths(Number(event.target.value))} /></label>
      <label>Spending view<select aria-label="Spending owner" value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">Everyone</option><option>David</option><option>Ariela</option><option>Shared</option></select></label>
    </section>
    <section className="instrument-panel income-editor"><div className="section-heading"><div><p className="eyebrow">Recurring plan</p><h2>{editingIncome ? `Edit ${editingIncome.title}` : "Add planned income"}</h2></div>{editingIncome && <button className="quiet-button" onClick={() => setEditingIncome(undefined)}>Cancel edit</button>}</div><form onSubmit={saveIncome} key={editingIncome?.source_id || "new"}><label>Title<input ref={incomeTitle} required name="title" maxLength={120} defaultValue={editingIncome?.title || ""} placeholder="Paycheck or rental" /></label><label>Type<select name="type" defaultValue={editingIncome?.income_type || "Salary"}><option>Salary</option><option>Custom</option></select></label><label>Monthly amount<input required name="amount" type="number" min="0" step="0.01" defaultValue={editingIncome ? (editingIncome.amount_minor / 100).toFixed(2) : ""} /></label><button>{editingIncome ? "Save income" : "Add income"}</button></form>{data?.incomes.length ? <div className="income-edit-list">{data.incomes.map((income) => <button className="text-button" key={income.source_id} onClick={() => setEditingIncome(income)}>Edit {income.title}</button>)}</div> : null}</section>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!data ? <div className="page-state">Reading the plan…</div> : <>
      <section className="planning-summary"><span>Planned income<strong>{formatMoney(data.planned_income_total_minor)}</strong></span><span>Category targets<strong>{formatMoney(data.target_total_minor)}</strong></span><span>Surplus / shortfall<strong className={data.surplus_shortfall_minor < 0 ? "negative" : "positive"}>{formatMoney(data.surplus_shortfall_minor)}</strong></span><span>Tzedaka minimum<strong>{formatMoney(data.tzedaka_minimum_minor)}</strong><small>10% of Salary</small></span></section>
      {owner && <p className="owner-plan-note">Showing {owner} actuals and averages. Targets remain household targets.</p>}
      <section className="instrument-panel planning-canvas"><div className="planning-legend"><span className="average">Historical average</span><span className="target">Your target</span><span className="actual">Spent this month</span></div><PlanningFlow incomes={data.incomes} categories={data.categories} total={data.planned_income_total_minor} onCategory={openCategory} /></section>
    </>}
    {selected && <CategoryDrawer category={selected} transactions={transactions} onClose={() => setSelected(undefined)} returnFocus={returnFocus} onSaveTarget={saveTarget} />}
  </div>;
}
