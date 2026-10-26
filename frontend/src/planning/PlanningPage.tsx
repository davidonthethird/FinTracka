import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { formatMoney } from "../format";
import { ManualCashDialog } from "../transactions/ManualCashDialog";
import { effectiveCategorizationScope, readCategorizationScope, scopeMessage, writeCategorizationScope, type CategorizationScope } from "../transactions/categorization";
import { CategoryDrawer } from "./CategoryDrawer";
import { PlanningFlow } from "./PlanningFlow";
import { coverageLabel, type PlanningCategory, type PlanningIncome, type PlanningSnapshot, type SpendingOwner, planningPath, visiblePlanningCategories } from "./model";

type Transaction = { id: string; transaction_id: string; local_date: string; description: string; merchant?: string; amount_minor: number; currency: string; category_id?: string; subcategory?: string; updated_at: string; is_cash_withdrawal: boolean };
type CategorizeResult = { affected_count: number; undo_id: string };

export function PlanningPage() {
  const [month, setMonth] = useState(() => new Date().toLocaleDateString("en-CA").slice(0, 7));
  const [averageMonths, setAverageMonths] = useState(12);
  const [owner, setOwner] = useState("");
  const [splitPeople, setSplitPeople] = useState(false);
  const [ownerSnapshots, setOwnerSnapshots] = useState<Partial<Record<SpendingOwner, PlanningSnapshot>>>({});
  const [detailOwner, setDetailOwner] = useState<SpendingOwner>();
  const [showInactive, setShowInactive] = useState(false);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<PlanningSnapshot>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PlanningCategory>();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
  const [editingIncome, setEditingIncome] = useState<PlanningIncome>();
  const [cashCategoryId, setCashCategoryId] = useState<string>();
  const [categorizationScope, setCategorizationScope] = useState<CategorizationScope>(() => readCategorizationScope());
  const [categorizationFeedback, setCategorizationFeedback] = useState<{ tone: "status" | "error"; text: string }>();
  const [undoId, setUndoId] = useState("");
  const incomeTitle = useRef<HTMLInputElement>(null);
  const categoryRequest = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<PlanningSnapshot>(planningPath(month, averageMonths, owner), { signal: controller.signal })
      .then(setData)
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load planning");
      });
    return () => controller.abort();
  }, [month, averageMonths, owner, revision]);

  useEffect(() => {
    if (!splitPeople) { setOwnerSnapshots({}); return; }
    const controller = new AbortController();
    Promise.all((["David", "Ariela", "Shared"] as SpendingOwner[]).map(async (person) => [
      person,
      await api<PlanningSnapshot>(planningPath(month, averageMonths, person), { signal: controller.signal }),
    ] as const)).then((rows) => setOwnerSnapshots(Object.fromEntries(rows))).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load person breakdown");
    });
    return () => controller.abort();
  }, [month, averageMonths, splitPeople, revision]);

  function openCategory(category: PlanningCategory, trigger: HTMLElement, person?: SpendingOwner) {
    setReturnFocus(trigger); setSelected(category); setDetailOwner(person);
    setCategorizationFeedback(undefined); setUndoId("");
  }
  useEffect(() => {
    if (!selected) { setTransactions([]); return; }
    const request = ++categoryRequest.current;
    const controller = new AbortController();
    const selectedPerson = detailOwner || owner;
    const ownerQuery = selectedPerson ? `?spending_owner=${encodeURIComponent(selectedPerson)}` : "";
    api<Transaction[]>(`/planning/${month}/categories/${encodeURIComponent(selected.category_id)}/transactions${ownerQuery}`, { signal: controller.signal })
      .then((result) => { if (request === categoryRequest.current) setTransactions(result); })
      .catch(() => { if (!controller.signal.aborted && request === categoryRequest.current) setTransactions([]); });
    return () => controller.abort();
  }, [selected?.category_id, detailOwner, owner, month, revision]);
  useEffect(() => {
    if (!selected || !data) return;
    const refreshed = data.categories.find((category) => category.category_id === selected.category_id);
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [data, selected]);
  function changeCategorizationScope(scope: CategorizationScope) {
    setCategorizationScope(scope); writeCategorizationScope(scope);
  }
  async function categorizeTransaction(transaction: Transaction, categoryId: string): Promise<boolean> {
    try {
      const appliedScope = effectiveCategorizationScope(categorizationScope, transaction.is_cash_withdrawal);
      const result = await api<CategorizeResult>(`/transactions/${transaction.transaction_id}/categorize`, {
        method: "POST",
        body: JSON.stringify({ expected_updated_at: transaction.updated_at, category_id: categoryId, scope: appliedScope }),
      });
      setUndoId(result.undo_id);
      setCategorizationFeedback({ tone: "status", text: `${result.affected_count} transaction${result.affected_count === 1 ? " was" : "s were"} categorized. ${scopeMessage(appliedScope)}` });
      setRevision((value) => value + 1);
      return true;
    } catch (caught) {
      setCategorizationFeedback({ tone: "error", text: caught instanceof Error ? caught.message : "Unable to categorize transaction" });
      return false;
    }
  }
  async function undoCategorization() {
    if (!undoId) return;
    try {
      const result = await api<{ restored_count: number }>(`/categorizations/${undoId}/undo`, { method: "POST", body: "{}" });
      setUndoId("");
      setCategorizationFeedback({ tone: "status", text: `${result.restored_count} transaction${result.restored_count === 1 ? " was" : "s were"} restored.` });
      setRevision((value) => value + 1);
    } catch (caught) {
      setCategorizationFeedback({ tone: "error", text: caught instanceof Error ? caught.message : "Unable to undo categorization" });
    }
  }
  async function saveTarget(amountMinor: number, oneMonth: boolean) {
    if (!selected) return;
    await api(oneMonth ? `/planning/targets/${selected.category_id}/overrides/${month}` : `/planning/targets/${selected.category_id}`, {
      method: "PUT",
      body: JSON.stringify(oneMonth
        ? { expected_updated_at: selected.updated_at, amount_minor: amountMinor }
        : { expected_updated_at: selected.updated_at, effective_month: month, amount_minor: amountMinor }),
    });
    setSelected(undefined); setRevision((value) => value + 1);
  }
  async function saveIncome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = { title: form.get("title"), income_type: form.get("type"), amount_minor: Math.round(Number(form.get("amount")) * 100), effective_month: month };
    try {
      if (editingIncome && form.get("scope") === "month") {
        await api(`/planning/income-sources/${editingIncome.source_id}/overrides/${month}`, {
          method: "PUT",
          body: JSON.stringify({ expected_updated_at: editingIncome.updated_at, amount_minor: payload.amount_minor }),
        });
      } else if (editingIncome) {
        await api(`/planning/income-sources/${editingIncome.source_id}`, { method: "PATCH", body: JSON.stringify({ ...payload, expected_updated_at: editingIncome.updated_at, active: true }) });
      } else {
        await api("/planning/income-sources", { method: "POST", body: JSON.stringify(payload) });
      }
      formElement.reset(); setEditingIncome(undefined); setRevision((value) => value + 1);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save income source"); }
  }
  async function deactivateIncome(income: PlanningIncome) {
    await api(`/planning/income-sources/${income.source_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        expected_updated_at: income.updated_at, title: income.title, income_type: income.income_type,
        amount_minor: income.amount_minor, effective_month: month, active: false,
      }),
    });
    setEditingIncome(undefined); setRevision((value) => value + 1);
  }
  useEffect(() => { if (editingIncome) incomeTitle.current?.focus(); }, [editingIncome]);

  const visibleCategories = data ? visiblePlanningCategories(data.categories, showInactive) : [];
  const inactiveCount = data ? data.categories.length - visiblePlanningCategories(data.categories, false).length : 0;
  return <div className="page planning-page">
    <header className="page-title"><div><p className="eyebrow">FinTracka</p><h1>Planning</h1></div><p>Usual spending, your targets, and this month’s actuals</p></header>
    <section className="planning-toolbar" aria-label="Planning controls">
      <label>Month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
      <label className="window-control">Average window: <strong>{averageMonths} months</strong><input aria-label="Average window" type="range" min="1" max="12" value={averageMonths} onChange={(event) => setAverageMonths(Number(event.target.value))} /></label>
      <label>Spending view<select aria-label="Spending owner" value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">Everyone</option><option>David</option><option>Ariela</option><option>Shared</option></select></label>
      <label className="inactive-toggle"><input aria-label="Split spending by person" type="checkbox" checked={splitPeople} onChange={(event) => { setSplitPeople(event.target.checked); if (event.target.checked) setOwner(""); }} /><span>Split by person</span></label>
      <label className="inactive-toggle"><input aria-label="Show inactive categories" type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /><span>Show inactive categories{inactiveCount ? ` (${inactiveCount})` : ""}</span></label>
    </section>
    <section className="instrument-panel income-editor"><div className="section-heading"><div><p className="eyebrow">Recurring plan</p><h2>{editingIncome ? `Edit ${editingIncome.title}` : "Add planned income"}</h2></div>{editingIncome && <button className="quiet-button" onClick={() => setEditingIncome(undefined)}>Cancel edit</button>}</div><form onSubmit={saveIncome} key={editingIncome?.source_id || "new"}><label>Title<input ref={incomeTitle} required name="title" maxLength={120} defaultValue={editingIncome?.title || ""} placeholder="Paycheck or rental" /></label><label>Type<select name="type" defaultValue={editingIncome?.income_type || "Salary"}><option>Salary</option><option>Custom</option></select></label><label>Monthly amount<input required name="amount" type="number" min="0" step="0.01" defaultValue={editingIncome ? (editingIncome.amount_minor / 100).toFixed(2) : ""} /></label>{editingIncome && <label>Apply<select name="scope" defaultValue="recurring"><option value="recurring">This and future months</option><option value="month">This month only</option></select></label>}<button>{editingIncome ? "Save income" : "Add income"}</button></form>{data?.incomes.length ? <div className="income-edit-list">{data.incomes.map((income) => <span key={income.source_id}><button className="text-button" onClick={() => setEditingIncome(income)}>Edit {income.title}</button><button className="text-button destructive" onClick={() => deactivateIncome(income)}>Stop from {month}</button></span>)}</div> : null}</section>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!data ? <div className="page-state">Reading the plan…</div> : <>
      <p className="planning-coverage">Historical averages use {coverageLabel(data)}{data.elapsed_days && data.days_in_month ? ` · day ${data.elapsed_days} of ${data.days_in_month}` : ""}</p>
      <section className="planning-status" data-testid="planning-status" aria-live="polite"><div><small>Monthly target</small><b>{formatMoney(data.target_total_minor)}</b></div><div data-testid="spent-so-far"><small>Spent so far</small><b className="negative">{formatMoney(data.actual_total_minor)}</b><span>{data.percent_used_basis_points === null ? "No target percentage" : `${(data.percent_used_basis_points / 100).toFixed(1)}% of target used`}</span></div><div data-testid="remaining-budget"><small>{data.remaining_total_minor < 0 ? "Over target" : "Remaining"}</small><b className={data.remaining_total_minor > 0 ? "positive" : "negative"}>{formatMoney(Math.abs(data.remaining_total_minor))}</b><span className={data.remaining_total_minor > 0 ? "positive" : "negative"}>{data.percent_remaining_basis_points === null ? "No percentage" : `${Math.abs(data.percent_remaining_basis_points / 100).toFixed(1)}% ${data.percent_remaining_basis_points < 0 ? "over" : "left"}`}</span></div></section>
      <section className="planning-summary secondary"><span>Remaining after targets<strong className={data.surplus_shortfall_minor > 0 ? "positive" : "negative"}>{formatMoney(data.surplus_shortfall_minor)}</strong></span><span>Tzedaka minimum<strong>{formatMoney(data.tzedaka_minimum_minor)}</strong><small>10% of Salary</small></span></section>
      {owner && <p className="owner-plan-note">Showing {owner} actuals and averages. Targets remain household targets.</p>}
      <section className="instrument-panel planning-canvas"><div className="planning-legend"><span className="average">Historical average</span><span className="target">Your target</span><span className="actual">Spent this month</span>{splitPeople && <><span className="owner-key owner-david">David</span><span className="owner-key owner-ariela">Ariela</span><span className="owner-key owner-shared">Shared</span></>}</div><PlanningFlow incomes={data.incomes} categories={visibleCategories} total={data.planned_income_total_minor} onCategory={openCategory} ownerSnapshots={splitPeople ? ownerSnapshots : undefined} /></section>
    </>}
    {selected && data && <CategoryDrawer category={selected} categories={data.categories} context={detailOwner} coverage={coverageLabel(data)} transactions={transactions} scope={categorizationScope} feedback={categorizationFeedback} undoAvailable={Boolean(undoId)} onScopeChange={changeCategorizationScope} onCategorize={categorizeTransaction} onUndo={undoCategorization} onClose={() => { setSelected(undefined); setDetailOwner(undefined); }} returnFocus={returnFocus} onSaveTarget={saveTarget} onAddCash={() => { setCashCategoryId(selected.category_id); setSelected(undefined); }} />}
    {cashCategoryId && data && <ManualCashDialog defaultCategoryId={cashCategoryId} categories={data.categories.map((category) => ({ id: category.category_id, name: category.category, category_type: "expense" }))} onClose={() => setCashCategoryId(undefined)} onSaved={() => { setCashCategoryId(undefined); setRevision((value) => value + 1); }} />}
  </div>;
}
