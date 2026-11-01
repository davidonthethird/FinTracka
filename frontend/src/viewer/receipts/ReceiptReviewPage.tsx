import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";

import type { ClassificationTaxonomy } from "../model";
import { useReceipts } from "./ReceiptProvider";
import type { ReceiptDraft, ReceiptDraftV1, ReceiptLineV1, SpendingOwner } from "./types";

export function ReceiptReviewPage({ id, taxonomy, navigate }: {
  id: string; taxonomy: ClassificationTaxonomy | null; navigate: (path: string) => void;
}) {
  const receipts = useReceipts();
  const [current, setCurrent] = useState<ReceiptDraft>();
  const [draft, setDraft] = useState<ReceiptDraftV1>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const known = receipts.drafts.find((item) => item.id === id);
    Promise.resolve(known ?? receipts.load(id)).then((value) => {
      if (!active) return; setCurrent(value); setDraft(toDraft(value));
    }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Receipt not found"); });
    return () => { active = false; };
  }, [id, receipts.drafts, receipts.load]);

  async function save() {
    if (!current || !draft) return;
    setSaving(true); setError("");
    try {
      const result = await receipts.save(current, { ...draft, status: "waiting_for_bank" });
      setCurrent(result); setDraft(toDraft(result)); navigate("/receipts");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Receipt save failed"); }
    finally { setSaving(false); }
  }
  if (error && !draft) return <div className="viewer-empty"><h2>Receipt unavailable</h2><p>{error}</p></div>;
  if (!current || !draft) return <div className="viewer-empty"><h2>Loading receipt…</h2></div>;
  return <div className="viewer-page"><header className="viewer-heading"><div><span>Review every item</span><h1>Receipt details</h1></div><button className="icon-button" onClick={() => navigate("/receipts")} aria-label="Back"><ArrowLeft /></button></header>
    {error && <p className="receipt-error" role="alert">{error}</p>}
    <ReceiptReviewForm draft={{ ...current, ...draft }} taxonomy={taxonomy} saving={saving}
      onChange={setDraft} onSave={() => void save()} />
  </div>;
}

export function ReceiptReviewForm({ draft, taxonomy, saving, onChange, onSave }: {
  draft: ReceiptDraft; taxonomy: ClassificationTaxonomy | null; saving: boolean;
  onChange: (draft: ReceiptDraftV1) => void; onSave: () => void;
}) {
  const editable = toDraft(draft);
  const calculated = useMemo(() => editable.lines.reduce((sum, line) => sum
    + line.item_total_minor - line.line_discount_minor + line.tax_minor + line.tip_minor + line.fees_minor, 0), [editable.lines]);
  const difference = editable.total_minor - calculated;
  const canSave = !saving && editable.lines.length > 0 && editable.lines.every((line) => line.owner)
    && difference === 0;
  const updateLine = (id: string, update: Partial<ReceiptLineV1>) => onChange({ ...editable,
    lines: editable.lines.map((line) => line.id === id ? { ...line, ...update } : line) });
  return <div className="receipt-review">
    <section className="receipt-fields">
      <label>Merchant<input value={editable.merchant} onChange={(event) => onChange({ ...editable, merchant: event.target.value })} /></label>
      <label>Date<input type="date" value={editable.purchase_date ?? ""} onChange={(event) => onChange({ ...editable, purchase_date: event.target.value || null })} /></label>
      <label>Total<input inputMode="decimal" value={(editable.total_minor / 100).toFixed(2)} onChange={(event) => onChange({ ...editable, total_minor: cents(event.target.value) })} /></label>
    </section>
    <div className="receipt-line-heading"><h2>Items</h2><button onClick={() => onChange({ ...editable, lines: [...editable.lines, blankLine(editable.lines.length)] })}><Plus /> Add item</button></div>
    <section className="receipt-lines">{editable.lines.map((line) => <article key={line.id} className={line.review_flags.length ? "needs-review" : ""}>
      <div className="receipt-line-primary"><input aria-label="Item description" value={line.description} onChange={(event) => updateLine(line.id, { description: event.target.value })} />
        <label>$<input aria-label="Item amount" inputMode="decimal" value={(line.item_total_minor / 100).toFixed(2)} onChange={(event) => updateLine(line.id, { item_total_minor: cents(event.target.value), unit_amount_minor: cents(event.target.value) })} /></label>
        <button aria-label={`Remove ${line.description}`} onClick={() => onChange({ ...editable, lines: editable.lines.filter((item) => item.id !== line.id).map((item, order) => ({ ...item, order })) })}><Trash2 /></button></div>
      {line.review_flags.includes("possible_duplicate") && <p>Possible duplicate from overlapping photos — keep or remove it.</p>}
      <div className="receipt-owner" aria-label="Spent by">{(["David", "Ariela", "Shared"] as SpendingOwner[]).map((owner) => <button key={owner} className={owner.toLowerCase()} aria-pressed={line.owner === owner} onClick={() => updateLine(line.id, { owner })}>{owner}</button>)}</div>
      {taxonomy && <div className="receipt-taxonomy"><select aria-label="Category" value={line.category_id ?? ""} onChange={(event) => updateLine(line.id, { category_id: event.target.value || null, subcategory_id: null })}><option value="">Inherit transaction category</option>{taxonomy.categories.filter((item) => item.category_type === "expense").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select aria-label="Subcategory" value={line.subcategory_id ?? ""} disabled={!line.category_id} onChange={(event) => updateLine(line.id, { subcategory_id: event.target.value || null })}><option value="">No subcategory</option>{taxonomy.subcategories.filter((item) => item.category_id === line.category_id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>}
    </article>)}</section>
    <footer className={`receipt-reconciliation ${difference === 0 ? "balanced" : "unbalanced"}`}><span>Items + allocated tax, tip, and fees</span><strong>{money(calculated, editable.currency)}</strong><span>Receipt total</span><strong>{money(editable.total_minor, editable.currency)}</strong><b>{difference === 0 ? "Balanced exactly" : `${money(Math.abs(difference), editable.currency)} ${difference > 0 ? "still unassigned" : "over receipt"}`}</b>
      <button disabled={!canSave} onClick={onSave}>{saving ? "Saving…" : "Save and wait for bank transaction"}</button><small>No spending is added until you explicitly match this receipt.</small></footer>
  </div>;
}

function toDraft(draft: ReceiptDraft): ReceiptDraftV1 {
  const { id: _id, revision: _revision, digest: _digest, created_at: _created,
    updated_at: _updated, retention_at: _retention, ...value } = draft;
  return value;
}
function cents(value: string) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : 0; }
function money(minor: number, currency: string) { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100); }
function blankLine(order: number): ReceiptLineV1 { return { id: crypto.randomUUID(), order, source_page: null, description: "New item", quantity: "1", unit_amount_minor: 0, item_total_minor: 0, line_discount_minor: 0, tax_minor: 0, tip_minor: 0, fees_minor: 0, taxable: true, owner: "Shared", category_id: null, subcategory_id: null, confidence_basis_points: 10_000, review_flags: [] }; }
