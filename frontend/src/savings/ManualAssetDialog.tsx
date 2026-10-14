import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { ManualAsset } from "./model";

export function ManualAssetDialog({ asset, onClose, onSaved }: {
  asset?: ManualAsset;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      title: form.get("title"),
      kind: form.get("kind"),
      owner: form.get("owner"),
      current_value_minor: Math.round(Number(form.get("value")) * 100),
      as_of_date: form.get("date"),
      ...(asset ? { expected_updated_at: asset.updated_at } : {}),
    };
    try {
      await api(asset ? `/savings/assets/${asset.id}` : "/savings/assets", {
        method: asset ? "PATCH" : "POST", body: JSON.stringify(payload),
      });
      onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save asset"); }
  }

  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="asset-dialog-title">
      <div className="section-heading"><div><p className="eyebrow">Separate from Planning</p><h2 id="asset-dialog-title">{asset ? "Edit manual asset" : "Add manual asset"}</h2></div><button className="quiet-button" onClick={onClose}>Close</button></div>
      <form onSubmit={save}>
        <label>Title<input ref={titleRef} required maxLength={120} name="title" defaultValue={asset?.title || ""} /></label>
        <label>Type<select name="kind" defaultValue={asset?.kind || "savings"}><option value="savings">Cash savings</option><option value="investment">Investment</option><option value="other">Other asset</option></select></label>
        <label>Owner<select name="owner" defaultValue={asset?.owner || "Shared"}><option>Shared</option><option>David</option><option>Ariela</option></select></label>
        <label>Current value<input required min="0" step="0.01" type="number" name="value" defaultValue={asset ? (asset.current_value_minor / 100).toFixed(2) : ""} /></label>
        <label>Valuation date<input required type="date" name="date" defaultValue={asset?.as_of_date || new Date().toLocaleDateString("en-CA")} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button>{asset ? "Save asset" : "Add asset"}</button></div>
      </form>
    </section>
  </div>;
}
