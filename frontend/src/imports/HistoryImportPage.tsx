import { useEffect, useState } from "react";

import { api } from "../api";

type Account = { id: string; name: string; nickname?: string; currency: string; status: string };
type Preview = { row_count: number; already_imported: boolean; duplicate_suggestions: number };
type ImportResult = { imported_count: number; duplicate_suggestions: number };
type ImportPayload = { account_id: string; filename: string; content_base64: string };

export function HistoryImportPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [file, setFile] = useState<File>();
  const [payload, setPayload] = useState<ImportPayload>();
  const [preview, setPreview] = useState<Preview>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Account[]>("/accounts").then(setAccounts).catch((caught: Error) => setError(caught.message));
  }, []);

  function resetPreview() {
    setPayload(undefined); setPreview(undefined); setMessage(""); setError("");
  }

  async function previewHistory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !accountId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const nextPayload = { account_id: accountId, filename: file.name, content_base64: await fileBase64(file) };
      const result = await api<Preview>("/imports/csv/preview", { method: "POST", body: JSON.stringify(nextPayload) });
      setPayload(nextPayload); setPreview(result);
      setMessage(result.already_imported
        ? "This exact file has already been imported."
        : `${result.row_count} transaction${result.row_count === 1 ? "" : "s"} ready${result.duplicate_suggestions ? ` · ${result.duplicate_suggestions} possible duplicate${result.duplicate_suggestions === 1 ? "" : "s"}` : ""}.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to preview history"); }
    finally { setBusy(false); }
  }

  async function importHistory() {
    if (!payload || !preview || preview.already_imported) return;
    setBusy(true); setError("");
    try {
      const result = await api<ImportResult>("/imports/csv/commit", { method: "POST", body: JSON.stringify(payload) });
      setMessage(`${result.imported_count} transaction${result.imported_count === 1 ? "" : "s"} imported${result.duplicate_suggestions ? ` · ${result.duplicate_suggestions} marked for duplicate review` : ""}.`);
      setPreview(undefined); setPayload(undefined);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to import history"); }
    finally { setBusy(false); }
  }

  return <div className="page history-import-page">
    <header className="page-title"><div><p className="eyebrow">FinTracka</p><h1>History import</h1></div><p>Add older bank history without creating another Plaid Item</p></header>
    <div className="notice"><strong>Existing Plaid connections stay connected.</strong><span>Choose the matching account and import transactions downloaded from that bank.</span></div>
    <section className="instrument-panel history-import-panel">
      <div className="section-heading"><div><p className="eyebrow">CSV statement</p><h2>Preview before importing</h2></div><span>Maximum file size 5 MB</span></div>
      <form onSubmit={previewHistory}>
        <label>Account<select aria-label="Account" required value={accountId} onChange={(event) => { setAccountId(event.target.value); resetPreview(); }}><option value="" disabled>Select account…</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.nickname || account.name} · {account.currency}</option>)}</select></label>
        <label>CSV file<input aria-label="CSV file" required type="file" accept=".csv,text/csv" onChange={(event) => { setFile(event.target.files?.[0]); resetPreview(); }} /></label>
        <button disabled={busy}>{busy ? "Reading…" : "Preview history"}</button>
      </form>
      <p className="history-format-help">Supported columns include Date, Transaction Date, or Posted Date; Description or Payee; and either a signed Amount or separate Debit and Credit columns. Currency defaults to USD.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <div className={`import-result ${preview?.already_imported ? "warning" : ""}`} role="status"><span>{message}</span>{preview && !preview.already_imported && <button disabled={busy} onClick={importHistory}>{busy ? "Importing…" : "Import history"}</button>}</div>}
    </section>
  </div>;
}

function fileBase64(file: File): Promise<string> {
  if (file.size > 5_000_000) return Promise.reject(new Error("CSV exceeds the 5 MB size limit"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read CSV file"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.readAsDataURL(file);
  });
}
