import { useEffect, useMemo, useState } from "react";
import { Check, Pencil, Search, X } from "lucide-react";

import type { ClassificationTaxonomy, RemoteTransaction } from "./model";
import { proposedClassification, statusLabel, type MobileCommand } from "./mobileCommands";

interface EditorProps {
  transaction: RemoteTransaction;
  taxonomy: ClassificationTaxonomy;
  command?: MobileCommand;
  onSave: (input: {
    categoryId: string | null; subcategoryId: string | null;
    replaceCommandId: string | null; observedRevision?: number;
  }) => Promise<void>;
  onCancel: (commandId: string) => Promise<void>;
}

export function TransactionClassificationEditor({ transaction, taxonomy, command, onSave, onCancel }: EditorProps) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(transaction.category_id);
  const [subcategoryId, setSubcategoryId] = useState<string | null>(transaction.subcategory_id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setEditing(false); setSearch(""); setCategoryId(transaction.category_id);
    setSubcategoryId(transaction.subcategory_id); setError("");
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

  async function submit() {
    const replacing = command?.status === "pending" ? command.id : null;
    if (replacing && !window.confirm("Replace the existing pending proposal with this classification?")) return;
    setSaving(true); setError("");
    try {
      await onSave({
        categoryId, subcategoryId: categoryId === null ? null : subcategoryId,
        replaceCommandId: replacing, observedRevision: conflictRevision,
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
      {proposal && <div className="proposal-row"><span>Proposed classification</span><strong>{[proposal.category, proposal.subcategory].filter(Boolean).join(" / ")}</strong></div>}
    </div>
    {command?.status === "processing" && <p className="command-message">Applying on your Mac. This proposal can no longer be changed or cancelled.</p>}
    {command?.status === "applied" && <p className="command-message"><Check aria-hidden="true" /> Applied; refreshing financial data.</p>}
    {command?.status === "conflict" && <div className="command-message needs-review"><strong>Needs review</strong><span>The committed classification changed before this proposal was applied.</span></div>}
    {command?.status === "rejected" && <p className="command-message error">Rejected. Review the current transaction before trying again.</p>}
    {command && ["cancelled", "expired", "superseded"].includes(command.status) && <p className="command-message">This proposal is {statusLabel(command.status).toLocaleLowerCase()}.</p>}

    {!editing && !active && <button className="classification-edit" onClick={() => { if (command?.status === "conflict") { setCategoryId(command.category_id); setSubcategoryId(command.subcategory_id); } setEditing(true); }}><Pencil aria-hidden="true" />{command?.status === "conflict" ? "Review and resubmit" : "Edit classification"}</button>}
    {!editing && command?.status === "pending" && <div className="classification-actions"><button onClick={() => { setCategoryId(command.category_id); setSubcategoryId(command.subcategory_id); setEditing(true); }}><Pencil aria-hidden="true" />Replace proposal</button><button className="secondary" disabled={saving} onClick={() => void cancel()}><X aria-hidden="true" />Cancel proposal</button></div>}

    {editing && <div className="classification-form">
      <label className="classification-search"><Search aria-hidden="true" /><input aria-label="Search categories" placeholder="Search categories" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="category-picker" role="listbox" aria-label="Category">
        <button role="option" aria-selected={categoryId === null} className={categoryId === null ? "selected" : ""} onClick={() => { setCategoryId(null); setSubcategoryId(null); }}>Uncategorized</button>
        {filteredCategories.map((item) => <button key={item.id} role="option" aria-selected={categoryId === item.id} className={categoryId === item.id ? "selected" : ""} onClick={() => { setCategoryId(item.id); setSubcategoryId(null); }}><span>{item.name}</span>{item.group && <small>{item.group}</small>}</button>)}
      </div>
      {categoryId && <label className="subcategory-select"><span>Subcategory <small>Optional</small></span><select aria-label="Subcategory" value={subcategoryId ?? ""} onChange={(event) => setSubcategoryId(event.target.value || null)}><option value="">No subcategory</option>{subcategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <div className="classification-preview"><span>One-time change</span><strong>{currentCommitted} <span aria-hidden="true">→</span> {selected}</strong><small>This will not create a rule for future transactions.</small></div>
      {error && <p className="classification-error" role="alert">{error}</p>}
      <div className="classification-actions"><button disabled={saving || selected === currentCommitted} onClick={() => void submit()}><Check aria-hidden="true" />{saving ? "Submitting…" : command?.status === "pending" ? "Replace proposal" : "Save proposal"}</button><button className="secondary" disabled={saving} onClick={() => { setEditing(false); setError(""); }}>Keep current</button></div>
    </div>}
    {!editing && error && <p className="classification-error" role="alert">{error}</p>}
  </section>;
}

function classificationName(categoryId: string | null, subcategoryId: string | null, taxonomy: ClassificationTaxonomy): string {
  if (categoryId === null) return "Uncategorized";
  const category = taxonomy.categories.find((item) => item.id === categoryId)?.name ?? "Unavailable category";
  const subcategory = taxonomy.subcategories.find((item) => item.id === subcategoryId)?.name;
  return [category, subcategory].filter(Boolean).join(" / ");
}
