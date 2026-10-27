import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatMoney } from "../format";
import { CategorizationScopeControl } from "../transactions/CategorizationScopeControl";
import type { CategorizationScope } from "../transactions/categorization";
import { percentLabel, type PlanningCategory } from "./model";

type CategoryTransaction = { id: string; transaction_id: string; local_date: string; description: string; merchant?: string; amount_minor: number; currency: string; category_id?: string; subcategory?: string; updated_at: string; is_cash_withdrawal: boolean };

export function CategoryDrawer({
  category,
  categories,
  context,
  coverage,
  transactions,
  scope,
  feedback,
  undoAvailable,
  onScopeChange,
  onCategorize,
  onUndo,
  onClose,
  returnFocus,
  onSaveTarget,
  onAddCash,
}: {
  category: PlanningCategory;
  categories: PlanningCategory[];
  context?: string;
  coverage: string;
  transactions: CategoryTransaction[];
  scope: CategorizationScope;
  feedback?: { tone: "status" | "error"; text: string };
  undoAvailable: boolean;
  onScopeChange: (scope: CategorizationScope) => void;
  onCategorize: (transaction: CategoryTransaction, categoryId: string) => Promise<boolean>;
  onUndo: () => Promise<void>;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
  onSaveTarget: (amountMinor: number, oneMonth: boolean) => Promise<void>;
  onAddCash: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const [editingTransactionId, setEditingTransactionId] = useState<string>();
  const [pendingTransactionId, setPendingTransactionId] = useState<string>();
  useEffect(() => {
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") trapFocus(event, drawer.current);
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); returnFocus?.focus(); };
  }, [onClose, returnFocus]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await onSaveTarget(Math.round(Number(form.get("target")) * 100), form.get("scope") === "month");
  }
  async function categorize(transaction: CategoryTransaction, categoryId: string) {
    if (!categoryId || categoryId === transaction.category_id) return;
    setPendingTransactionId(transaction.transaction_id);
    const saved = await onCategorize(transaction, categoryId);
    setPendingTransactionId(undefined);
    if (saved) setEditingTransactionId(undefined);
  }
  return <div className="flow-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside ref={drawer} className="flow-drawer category-drawer" role="dialog" aria-modal="true" aria-label={`${category.category} planning details`}>
      <div className="section-heading"><div><p className="eyebrow">Category plan{context ? ` · ${context}` : ""}</p><h2>{category.category}</h2></div><button ref={close} className="quiet-button" onClick={onClose}>Close</button></div>
      <div className="drawer-metrics"><span>Historical average<strong>{formatMoney(category.historical_average_minor)}</strong><small>{coverage}</small></span><span>Target<strong>{formatMoney(category.target_minor)}</strong></span><span>Spent so far<strong>{formatMoney(category.actual_minor)}</strong><small>{percentLabel(category)}</small></span><span>Remaining<strong className={category.remaining_minor < 0 ? "negative" : "positive"}>{formatMoney(category.remaining_minor)}</strong></span></div>
      <div className="planning-trend" aria-label={`${category.category} spending trend`}><ResponsiveContainer width="100%" height="100%"><AreaChart data={category.trend}><CartesianGrid vertical={false} stroke="var(--line)"/><XAxis dataKey="month" tickLine={false}/><YAxis hide/><Tooltip formatter={(value) => formatMoney(Number(value))}/><Area dataKey="amount_minor" type="monotone" stroke="var(--teal)" fill="var(--teal-soft)"/></AreaChart></ResponsiveContainer></div>
      <form className="target-form" onSubmit={save}><label>Monthly target<input name="target" required type="number" min={(category.tzedaka_minimum_minor / 100).toFixed(2)} step="0.01" defaultValue={(category.target_minor / 100).toFixed(2)} /></label><label>Apply<select name="scope" defaultValue="recurring"><option value="recurring">This and future months</option><option value="month">This month only</option></select></label>{category.tzedaka_minimum_minor > 0 && <p>Tzedaka must remain at least {formatMoney(category.tzedaka_minimum_minor)} (10% of planned Salary).</p>}<button>Save target</button></form>
      {category.category === "Tzedaka" && <div className="drawer-quick-action"><button onClick={onAddCash}>Add Tzedaka cash spending</button></div>}
      <div className="subcategory-breakdown"><div className="drawer-list-title"><strong>Subcategory breakdown</strong><small>This month</small></div>{category.subcategories.length ? category.subcategories.map((item) => <div key={item.subcategory_id || "none"}><span>{item.subcategory}</span><b>{formatMoney(item.actual_minor)}</b></div>) : <p>No subcategory activity this month.</p>}</div>
      <div className="flow-entries editable-drawer-entries"><div className="drawer-list-title"><strong>This month’s transactions</strong><small>{transactions.length} item{transactions.length === 1 ? "" : "s"}</small></div><div className="drawer-category-tools"><span>Apply category changes</span><CategorizationScopeControl value={scope} onChange={onScopeChange} disabled={Boolean(pendingTransactionId)} /></div>{feedback && <p className={`drawer-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}{undoAvailable && feedback.tone === "status" && <button type="button" className="text-button" onClick={onUndo}>Undo</button>}</p>}{transactions.map((item) => {
        const label = item.merchant || item.description;
        const editing = editingTransactionId === item.transaction_id;
        const pending = pendingTransactionId === item.transaction_id;
        return <div className="drawer-transaction" key={item.id}><span><strong>{label}</strong><small>{item.local_date}{item.subcategory ? ` · ${item.subcategory}` : ""}{item.is_cash_withdrawal ? " · withdrawal changes apply once" : ""}</small>{editing ? <span className="drawer-category-editor"><select aria-label={`Category for ${label}`} value={item.category_id || ""} disabled={pending} onChange={(event) => categorize(item, event.target.value)}><option value="" disabled>Uncategorized</option>{categories.map((choice) => <option value={choice.category_id} key={choice.category_id}>{choice.category}</option>)}</select><button type="button" className="text-button" disabled={pending} onClick={() => setEditingTransactionId(undefined)}>Cancel</button></span> : <button type="button" className="text-button" aria-label={`Edit category for ${label}`} disabled={Boolean(pendingTransactionId && pendingTransactionId === item.transaction_id)} onClick={() => setEditingTransactionId(item.transaction_id)}>Edit</button>}</span><b className="negative">{formatMoney(item.amount_minor, item.currency)}</b></div>;
      })}</div>
    </aside>
  </div>;
}

function trapFocus(event: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return;
  const items = [...container.querySelectorAll<HTMLElement>("button, input, select, [tabindex]:not([tabindex='-1'])")].filter((item) => !item.hasAttribute("disabled"));
  if (!items.length) return;
  const first = items[0]; const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
