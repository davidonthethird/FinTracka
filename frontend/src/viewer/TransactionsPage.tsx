import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { formatMoney } from "../format";
import { TransactionDrawer } from "./TransactionDrawer";
import { classificationTaxonomy, filterTransactions, paginateTransactions, snapshotMonths, type RemoteSnapshot, type RemoteTransaction } from "./model";
import { activeCommandForTransaction, latestCommandForTransaction, proposedClassification, statusLabel, useMobileCommands, type MobileCommand } from "./mobileCommands";

export function TransactionsPage({ snapshot }: { snapshot: RemoteSnapshot }) {
  const mobile = useMobileCommands();
  const [search, setSearch] = useState("");
  const [account, setAccount] = useState("");
  const [category, setCategory] = useState("");
  const [owner, setOwner] = useState("");
  const [month, setMonth] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<RemoteTransaction>();
  const accounts = useMemo(() => unique(snapshot.transactions.map((item) => item.account_name)), [snapshot]);
  const categories = useMemo(() => unique(snapshot.transactions.map((item) => item.category_id ? `${item.category_id}|${item.category}` : "")), [snapshot]);
  const filtered = filterTransactions(snapshot.transactions, { search, account, category, owner, month });
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const visible = paginateTransactions(filtered, Math.min(page, pages));
  function update(setter: (value: string) => void, value: string) { setter(value); setPage(1); }
  return <div className="viewer-page transactions-view">
    <header className="viewer-heading"><div><span>{mobile.available ? "Household register" : "Read-only register"}</span><h1>Transactions</h1></div><strong>{filtered.length} shown</strong></header>
    {mobile.error && <div className="mobile-command-banner" role="status"><strong>Phone edits unavailable</strong><span>{mobile.error}</span><button onClick={() => void mobile.refresh()}>Try again</button></div>}
    <section className="transaction-tools" aria-label="Transaction filters">
      <label className="viewer-search"><Search aria-hidden="true" /><input aria-label="Search transactions" placeholder="Search merchant or description" value={search} onChange={(event) => update(setSearch, event.target.value)} /></label>
      <div className="filter-grid">
        <Filter label="Month" value={month} onChange={(value) => update(setMonth, value)} options={snapshotMonths(snapshot).map((value) => [value, value])} />
        <Filter label="Account" value={account} onChange={(value) => update(setAccount, value)} options={accounts.map((value) => [value, value])} />
        <Filter label="Category" value={category} onChange={(value) => update(setCategory, value)} options={categories.map((value) => { const [id, label] = value.split("|"); return [id, label]; })} />
        <Filter label="Spent by" value={owner} onChange={(value) => update(setOwner, value)} options={[["David", "David"], ["Ariela", "Ariela"], ["Shared", "Shared"]]} />
      </div>
    </section>
    <section className="transaction-register">{visible.length ? visible.map((item) => {
      const command = relevantCommand(mobile.commands, item);
      const active = command && (command.status === "pending" || command.status === "processing") ? command : undefined;
      const proposal = active ? proposedClassification(active, classificationTaxonomy(snapshot)) : undefined;
      return <button key={item.id} className="transaction-entry" onClick={() => setSelected(item)}>
      <time>{item.local_date.slice(5)}{command && <em className={`transaction-command-status ${command.status}`}>{statusLabel(command.status)}</em>}</time>
      <span><strong>{item.merchant || item.description}</strong><small>{proposal ? <><b>{proposal.category}{proposal.subcategory ? ` / ${proposal.subcategory}` : ""}</b> · Pending proposal</> : <>{item.category || "Uncategorized"} · {item.account_name}</>}</small></span>
      <i className="owner-slot">{item.spending_owner && <span className={`owner-dot ${item.spending_owner.toLowerCase()}`} title={item.spending_owner} />}</i>
      <b className={`transaction-amount ${item.amount_minor < 0 ? "negative" : "positive"}`}>{formatMoney(item.amount_minor, item.currency)}</b>
    </button>; }) : <div className="viewer-empty"><h2>No matching transactions</h2><p>Change or clear a filter to see more activity.</p></div>}</section>
    {pages > 1 && <nav className="page-controls" aria-label="Transaction pages"><button disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft /> Previous</button><span>{page} of {pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next <ChevronRight /></button></nav>}
    {selected && <TransactionDrawer transaction={selected} taxonomy={classificationTaxonomy(snapshot)} command={relevantCommand(mobile.commands, selected)} editingAvailable={mobile.available} onSave={async (input) => { await mobile.save({ transaction: selected, ...input }); }} onCancel={mobile.cancel} onClose={() => setSelected(undefined)} />}
  </div>;
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">All</option>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))].sort(); }

function relevantCommand(commands: MobileCommand[], transaction: RemoteTransaction): MobileCommand | undefined {
  const active = activeCommandForTransaction(commands, transaction.id);
  if (active) return active;
  const latest = latestCommandForTransaction(commands, transaction.id);
  if (!latest) return undefined;
  if (latest.status === "applied" && latest.result?.status === "applied"
    && (transaction.classification_revision ?? 0) >= latest.result.classification_revision
    && transaction.category_id === latest.result.category_id
    && transaction.subcategory_id === latest.result.subcategory_id) return undefined;
  return latest;
}
