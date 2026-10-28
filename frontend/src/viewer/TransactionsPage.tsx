import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { formatMoney } from "../format";
import { TransactionDrawer } from "./TransactionDrawer";
import { filterTransactions, paginateTransactions, snapshotMonths, type RemoteSnapshot, type RemoteTransaction } from "./model";

export function TransactionsPage({ snapshot }: { snapshot: RemoteSnapshot }) {
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
    <header className="viewer-heading"><div><span>Read-only register</span><h1>Transactions</h1></div><strong>{filtered.length} shown</strong></header>
    <section className="transaction-tools" aria-label="Transaction filters">
      <label className="viewer-search"><Search aria-hidden="true" /><input aria-label="Search transactions" placeholder="Search merchant or description" value={search} onChange={(event) => update(setSearch, event.target.value)} /></label>
      <div className="filter-grid">
        <Filter label="Month" value={month} onChange={(value) => update(setMonth, value)} options={snapshotMonths(snapshot).map((value) => [value, value])} />
        <Filter label="Account" value={account} onChange={(value) => update(setAccount, value)} options={accounts.map((value) => [value, value])} />
        <Filter label="Category" value={category} onChange={(value) => update(setCategory, value)} options={categories.map((value) => { const [id, label] = value.split("|"); return [id, label]; })} />
        <Filter label="Spent by" value={owner} onChange={(value) => update(setOwner, value)} options={[["David", "David"], ["Ariela", "Ariela"], ["Shared", "Shared"]]} />
      </div>
    </section>
    <section className="transaction-register">{visible.length ? visible.map((item) => <button key={item.id} className="transaction-entry" onClick={() => setSelected(item)}>
      <time>{item.local_date.slice(5)}</time>
      <span><strong>{item.merchant || item.description}</strong><small>{item.category || "Uncategorized"} · {item.account_name}</small></span>
      {item.spending_owner && <i className={`owner-dot ${item.spending_owner.toLowerCase()}`} title={item.spending_owner} />}
      <b className={item.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(item.amount_minor, item.currency)}</b>
    </button>) : <div className="viewer-empty"><h2>No matching transactions</h2><p>Change or clear a filter to see more activity.</p></div>}</section>
    {pages > 1 && <nav className="page-controls" aria-label="Transaction pages"><button disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft /> Previous</button><span>{page} of {pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next <ChevronRight /></button></nav>}
    {selected && <TransactionDrawer transaction={selected} onClose={() => setSelected(undefined)} />}
  </div>;
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">All</option>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))].sort(); }
