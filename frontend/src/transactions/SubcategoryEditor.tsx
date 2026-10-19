import { useEffect, useState } from "react";

import { api } from "../api";
import { effectiveCategorizationScope, type CategorizationScope } from "./categorization";

export type Subcategory = {
  id: string;
  category_id: string;
  name: string;
  sort_order: number;
  category_name: string;
};

type EditableTransaction = {
  id: string;
  merchant?: string;
  description: string;
  category_id?: string;
  subcategory_id?: string;
  subcategory_source?: string;
  is_cash_withdrawal: boolean;
  updated_at: string;
};
type Category = { id: string; updated_at: string };
type AssignmentResult = { affected_count: number; undo_id: string };

export function SubcategoryEditor({
  transaction,
  category,
  scope,
  onSaved,
}: {
  transaction: EditableTransaction;
  category?: Category;
  scope: CategorizationScope;
  onSaved: (result: AssignmentResult, appliedScope: CategorizationScope) => void;
}) {
  const [items, setItems] = useState<Subcategory[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const label = transaction.merchant || transaction.description;

  useEffect(() => {
    setCreating(false); setName(""); setError("");
    if (!transaction.category_id) { setItems([]); return; }
    const controller = new AbortController();
    api<Subcategory[]>(`/subcategories?category_id=${encodeURIComponent(transaction.category_id)}`, { signal: controller.signal })
      .then(setItems)
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load subcategories"); });
    return () => controller.abort();
  }, [transaction.category_id, transaction.updated_at]);

  async function assign(subcategoryId: string) {
    if (!subcategoryId) return;
    const appliedScope = effectiveCategorizationScope(scope, transaction.is_cash_withdrawal);
    try {
      setError("");
      const result = await api<AssignmentResult>(`/transactions/${transaction.id}/subcategory`, {
        method: "POST",
        body: JSON.stringify({ expected_updated_at: transaction.updated_at, subcategory_id: subcategoryId, scope: appliedScope }),
      });
      onSaved(result, appliedScope);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save subcategory"); }
  }

  async function createAndAssign(event: React.FormEvent) {
    event.preventDefault();
    if (!category) return;
    try {
      setError("");
      const created = await api<Subcategory>("/subcategories", {
        method: "POST",
        body: JSON.stringify({ expected_updated_at: category.updated_at, category_id: category.id, name }),
      });
      await assign(created.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to create subcategory"); }
  }

  if (!transaction.category_id) return <small>Choose a category first</small>;
  return <span className="subcategory-editor">
    <select aria-label={`Subcategory for ${label}`} value={transaction.subcategory_id || ""} onChange={(event) => assign(event.target.value)}>
      <option value="">No subcategory</option>
      {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
    {transaction.is_cash_withdrawal
      ? <small>Withdrawal · this choice applies once</small>
      : <small>{transaction.subcategory_source ? `${transaction.subcategory_source} subcategory` : "Optional detail"}</small>}
    {!creating && <button type="button" className="text-button" onClick={() => setCreating(true)}>Add custom subcategory</button>}
    {creating && <form className="subcategory-create" onSubmit={createAndAssign}>
      <label>New subcategory name<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <button>Create and choose</button>
      <button type="button" className="text-button" onClick={() => setCreating(false)}>Cancel</button>
    </form>}
    {error && <small className="form-error">{error}</small>}
  </span>;
}
