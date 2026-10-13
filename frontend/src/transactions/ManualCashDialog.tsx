import { useEffect, useRef, useState } from "react";

import { api } from "../api";

type Owner = "David" | "Ariela" | "Shared";
type Category = { id: string; name: string; category_type: string };
type CashTransaction = { id: string; local_date: string; amount_minor: number; description: string; category_id?: string; spending_owner?: Owner; updated_at: string };

export function ManualCashDialog({ categories, transaction, defaultCategoryId, onClose, onSaved }: { categories: Category[]; transaction?: CashTransaction; defaultCategoryId?: string; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState("");
  const close = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") trapFocus(event, dialog.current);
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); prior?.focus(); };
  }, [onClose]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      ...(transaction ? { expected_updated_at: transaction.updated_at } : {}),
      title: form.get("title"), amount_minor: Math.round(Number(form.get("amount")) * 100),
      category_id: form.get("category"), local_date: form.get("date"), spending_owner: form.get("owner"),
    };
    try {
      await api(transaction ? `/transactions/manual-cash/${transaction.id}` : "/transactions/manual-cash", { method: transaction ? "PATCH" : "POST", body: JSON.stringify(payload) });
      onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save cash spending"); }
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialog} className="dialog" role="dialog" aria-modal="true" aria-labelledby="cash-title"><div className="section-heading"><div><p className="eyebrow">Off-bank spending</p><h2 id="cash-title">{transaction ? "Edit cash spending" : "Add cash spending"}</h2></div><button ref={close} className="quiet-button" onClick={onClose}>Close</button></div><form onSubmit={save}><label>Title<input required name="title" maxLength={300} defaultValue={transaction?.description || ""} /></label><label>Amount<input required name="amount" type="number" min="0.01" step="0.01" defaultValue={transaction ? (Math.abs(transaction.amount_minor) / 100).toFixed(2) : ""} /></label><label>Category<select required name="category" defaultValue={transaction?.category_id || defaultCategoryId || ""}><option value="" disabled>Select category…</option>{categories.filter((category) => category.category_type === "expense").map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label>Date<input required name="date" type="date" defaultValue={transaction?.local_date || new Date().toLocaleDateString("en-CA")} /></label><label>Spent by<select name="owner" defaultValue={transaction?.spending_owner || "Shared"}><option>Shared</option><option>David</option><option>Ariela</option></select></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button>{transaction ? "Save changes" : "Add spending"}</button></div></form></section></div>;
}

function trapFocus(event: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return;
  const items = [...container.querySelectorAll<HTMLElement>("button, input, select, [tabindex]:not([tabindex='-1'])")].filter((item) => !item.hasAttribute("disabled"));
  if (!items.length) return;
  const first = items[0]; const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
