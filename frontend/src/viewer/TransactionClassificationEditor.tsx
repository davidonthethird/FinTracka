import { useEffect, useMemo, useState } from "react";
import { Check, Pencil, Search, X } from "lucide-react";

import type { ClassificationTaxonomy, RemoteTransaction } from "./model";
import {
  proposedClassification,
  statusLabel,
  type CategorizationScope,
  type MobileCommand,
} from "./mobileCommands";

export const DEFAULT_CLASSIFICATION_SCOPE: CategorizationScope = "past_and_future";

interface EditorProps {
  transaction: RemoteTransaction;
  taxonomy: ClassificationTaxonomy;
  command?: MobileCommand;
  onSave: (input: {
    categoryId: string | null; subcategoryId: string | null;
    replaceCommandId: string | null; observedRevision?: number; scope: CategorizationScope;
  }) => Promise<void>;
  onCancel: (commandId: string) => Promise<void>;
}

export function TransactionClassificationEditor({ transaction, taxonomy, command, onSave, onCancel }: EditorProps) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(transaction.category_id);
  const [subcategoryId, setSubcategoryId] = useState<string | null>(transaction.subcategory_id);
  const [scope, setScope] = useState<CategorizationScope>(DEFAULT_CLASSIFICATION_SCOPE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setEditing(false); setSearch(""); setCategoryId(transaction.category_id);
    setSubcategoryId(transaction.subcategory_id); setScope(DEFAULT_CLASSIFICATION_SCOPE); setError("");
  }, [transaction.id, transaction.classification_revision]);

  const active = command?.status === "pending" || command?.status === "processing";
  const proposal = command ? proposedClassification(command, taxonomy) : undefined;
  const filteredCategories = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return taxonomy.categories.filter((item) => !needle || `${item.name} ${item.group ?? ""}`.toLocaleLowerCase().includes(needle));
  }, [search, taxonomy.categories]);
  const subcategories = taxonomy.subcategories.filter((item) => item.category_id === categoryId);
  const selected = classificationName(categoryId, subcategoryId, taxonomy);
  const committed = [transaction.category, transaction.subcategory].filter(Boolean).join(" / ") || "Uncategorized";
  const conflictRevision = command?.status === "conflict" && command.result?.status === "conflict"
    ? command.result.classification_revision : undefined;
  const currentCommitted = command?.status === "conflict" && command.result?.status === "conflict"
    ? classificationName(command.result.category_id, command.result.subcategory_id, taxonomy)
    : committed;
  const forcedOneTime = transaction.is_cash_withdrawal || categoryId === null;
  const effectiveScope = effectiveClassificationScope(scope, transaction.is_cash_withdrawal, categoryId);

  function beginEditing(category = transaction.category_id, subcategory = transaction.subcategory_id) {
    setCategoryId(category); setSubcategoryId(subcategory);
    setScope(DEFAULT_CLASSIFICATION_SCOPE); setEditing(true);
  }

  async function submit() {
    const replacing = command?.status === "pending" ? command.id : null;
    if (replacing && !window.confirm("Replace the existing pending proposal with this classification?")) return;
    setSaving(true); setError("");
    try {
      await onSave({
        categoryId, subcategoryId: categoryId === null ? null : subcategoryId,
        replaceCommandId: replacing, observedRevision: conflictRevision, scope: effectiveScope,
      });
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The edit could not be submitted.");
    } finally { setSaving(false); }
  }

  async function cancel() {
    if (!command || !window.confirm("Cancel this pending classification proposal?")) return;
    setSaving(true); setError("");
    try { await onCancel(command.id); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The proposal could not be cancelled."); }
    finally { setSaving(false); }
  }

  return <section className="classification-editor" aria-labelledby="classification-heading">
    <div className="classification-title"><div><span>Phone edit</span><h3 id="classification-heading">Classification</h3></div>{command && <strong className={`command-status ${command.status}`}>{statusLabel(command.status)}</strong>}</div>
    <div className="classification-comparison">
      <div><span>{command?.status === "conflict" ? "Current on Mac" : "Committed classification"}</span><strong>{currentCommitted}</strong></div>
      {proposal && <div className="proposal-row"><span>Proposed classification</span><strong>{[proposal.category, proposal.subcategory].filter(Boolean).join(" / ")}</strong><small>{scopeLabel(proposal.scope)}</small></div>}
    </div>
    {command?.status === "processing" && <p className="command-message">Applying on your Mac. This proposal can no longer be changed or cancelled.</p>}
    {command?.status === "applied" && <p className="command-message"><Check aria-hidden="true" /> Applied; refreshing financial data.</p>}
    {command?.status === "conflict" && <div className="command-message needs-review"><strong>Needs review</strong><span>The committed classification changed before this proposal was applied.</span></div>}
    {command?.status === "rejected" && <p className="command-message error">Rejected. Review the current transaction before trying again.</p>}
    {command && ["cancelled", "expired", "superseded"].includes(command.status) && <p className="command-message">This proposal is {statusLabel(command.status).toLocaleLowerCase()}.</p>}

    {!editing && !active && <button className="classification-edit" onClick={() => beginEditing(command?.status === "conflict" ? command.category_id : transaction.category_id, command?.status === "conflict" ? command.subcategory_id : transaction.subcategory_id)}><Pencil aria-hidden="true" />{command?.status === "conflict" ? "Review and resubmit" : "Edit classification"}</button>}
    {!editing && command?.status === "pending" && <div className="classification-actions"><button onClick={() => beginEditing(command.category_id, command.subcategory_id)}><Pencil aria-hidden="true" />Replace proposal</button><button className="secondary" disabled={saving} onClick={() => void cancel()}><X aria-hidden="true" />Cancel proposal</button></div>}

    {editing && <div className="classification-form">
      <label className="classification-search"><Search aria-hidden="true" /><input aria-label="Search categories" placeholder="Search categories" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="category-picker" role="listbox" aria-label="Category">
        <button role="option" aria-selected={categoryId === null} className={categoryId === null ? "selected" : ""} onClick={() => { setCategoryId(null); setSubcategoryId(null); }}>Uncategorized</button>
        {filteredCategories.map((item) => <button key={item.id} role="option" aria-selected={categoryId === item.id} className={categoryId === item.id ? "selected" : ""} onClick={() => { setCategoryId(item.id); setSubcategoryId(null); }}><span>{item.name}</span>{item.group && <small>{item.group}</small>}</button>)}
      </div>
      {categoryId && <label className="subcategory-select"><span>Subcategory <small>Optional</small></span><select aria-label="Subcategory" value={subcategoryId ?? ""} onChange={(event) => setSubcategoryId(event.target.value || null)}><option value="">No subcategory</option>{subcategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <ClassificationScopeControl value={effectiveScope} forcedOneTime={forcedOneTime} onChange={setScope} />
      <div className="classification-preview"><span>{scopeLabel(effectiveScope)}</span><strong>{currentCommitted} <span aria-hidden="true">→</span> {selected}</strong><small>{scopeDescription(effectiveScope, transaction.is_cash_withdrawal, categoryId)}</small></div>
      {error && <p className="classification-error" role="alert">{error}</p>}
      <div className="classification-actions"><button disabled={saving || (selected === currentCommitted && effectiveScope === "one_time")} onClick={() => void submit()}><Check aria-hidden="true" />{saving ? "Submitting…" : command?.status === "pending" ? "Replace proposal" : "Save proposal"}</button><button className="secondary" disabled={saving} onClick={() => { setEditing(false); setError(""); }}>Keep current</button></div>
    </div>}
    {!editing && error && <p className="classification-error" role="alert">{error}</p>}
  </section>;
}

export function ClassificationScopeControl({ value, forcedOneTime, onChange }: {
  value: CategorizationScope;
  forcedOneTime: boolean;
  onChange: (scope: CategorizationScope) => void;
}) {
  const options: { value: CategorizationScope; icon: string; label: string; title: string }[] = [
    { value: "one_time", icon: "1×", label: "One time", title: "Change only this transaction" },
    { value: "future", icon: "→", label: "Future", title: "Change this transaction and learn for future matches" },
    { value: "past_and_future", icon: "↔", label: "Past + future", title: "Change eligible past matches and learn for future matches" },
  ];
  return <fieldset className="classification-scope">
    <legend>Apply this change</legend>
    <div className="classification-scope-options">
      {options.map((option) => <button
        key={option.value}
        type="button"
        aria-pressed={value === option.value}
        aria-label={option.label}
        title={option.title}
        disabled={forcedOneTime && option.value !== "one_time"}
        onClick={() => onChange(option.value)}
      ><strong aria-hidden="true">{option.icon}</strong><span>{option.label}</span></button>)}
    </div>
  </fieldset>;
}

export function effectiveClassificationScope(
  selected: CategorizationScope,
  isCashWithdrawal: boolean,
  categoryId: string | null,
): CategorizationScope {
  return isCashWithdrawal || categoryId === null ? "one_time" : selected;
}

function scopeLabel(scope: CategorizationScope): string {
  return ({ one_time: "One time", future: "Current + future", past_and_future: "Past + future" })[scope];
}

function scopeDescription(
  scope: CategorizationScope,
  isCashWithdrawal: boolean,
  categoryId: string | null,
): string {
  if (isCashWithdrawal) return "Cash withdrawals are unique, so this applies only once.";
  if (categoryId === null) return "Removing a category applies only to this transaction.";
  return ({
    one_time: "Only this transaction changes; no rule is created.",
    future: "This transaction changes and future matches will follow this rule.",
    past_and_future: "Eligible past matches change and future matches will follow this rule.",
  })[scope];
}

function classificationName(categoryId: string | null, subcategoryId: string | null, taxonomy: ClassificationTaxonomy): string {
  if (categoryId === null) return "Uncategorized";
  const category = taxonomy.categories.find((item) => item.id === categoryId)?.name ?? "Unavailable category";
  const subcategory = taxonomy.subcategories.find((item) => item.id === subcategoryId)?.name;
  return [category, subcategory].filter(Boolean).join(" / ");
}
