import { useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { api } from "./api";
import { currentMonth, formatMoney, movementWidths } from "./format";

type OverviewData = { cash_minor: number; card_liabilities_minor: number; net_position_minor: number; income_minor: number; spending_minor: number };
type Account = { id: string; name: string; nickname?: string; nature: string; subtype?: string; currency: string; status: string; balance_minor?: number; include_overview: number; include_budget: number; include_net: number; include_export: number; updated_at: string };
type Transaction = { id: string; account_id: string; local_date: string; amount_minor: number; currency: string; description: string; merchant?: string; category_id?: string; category?: string; notes?: string; pending: boolean; updated_at: string };
type Category = { id: string; name: string; category_type: string; reporting_behavior: string };
type TrackingRow = { category_id: string; category: string; target_minor: number; actual_minor: number; variance_minor: number };
type EnvelopeRow = { category_id: string; category: string; allocated_minor: number; activity_minor: number; available_minor: number };
type EnvelopeData = { month: string; available_to_assign_minor: number; categories: EnvelopeRow[] };
type Rule = { id: string; name: string; priority: number; enabled: number; conditions_json: string; category_id: string; category?: string };
type RulePreview = { rule_id: string; name: string; priority: number; match_count: number };
type TransferCandidate = { transaction_a: string; transaction_b: string; external_a: string; external_b: string; confidence: string };
type Connection = { id: string; provider: string; status: string; last_success_at?: string; last_error_code?: string };

const nav = [
  ["/", "Overview"], ["/accounts", "Accounts"], ["/transactions", "Transactions"],
  ["/tracking-budget", "Tracking budget"], ["/envelope-budget", "Envelope budget"],
  ["/reports", "Reports"], ["/rules", "Rules"], ["/connections", "Connections"], ["/settings", "Settings"],
];

export function App() {
  const [dark, setDark] = useState(() => localStorage.getItem("fintracka-theme") === "dark");
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; localStorage.setItem("fintracka-theme", dark ? "dark" : "light"); }, [dark]);
  return <div className="app-shell">
    <aside className="rail">
      <div className="wordmark"><span>F</span> FinTracka</div>
      <p className="rail-caption">Private ledger</p>
      <nav>{nav.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"}>{label}</NavLink>)}</nav>
      <div className="rail-foot"><span className="status-dot" /> Local only</div>
    </aside>
    <main className="workspace">
      <header className="topbar"><span>America/New_York · USD reporting</span><button className="quiet-button" onClick={() => setDark(!dark)}>{dark ? "Light mode" : "Dark mode"}</button></header>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/tracking-budget" element={<TrackingBudgetPage />} />
        <Route path="/envelope-budget" element={<EnvelopeBudgetPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/settings" element={<SettingsPage dark={dark} setDark={setDark} />} />
      </Routes>
    </main>
  </div>;
}

function OverviewPage() {
  const month = currentMonth();
  const overview = useData<OverviewData>(`/overview?month=${month}`);
  const transactions = useData<{ items: Transaction[] }>("/transactions?limit=7");
  if (overview.loading || transactions.loading) return <PageState text="Reading the ledger…" />;
  if (overview.error || transactions.error) return <PageState error text={overview.error || transactions.error || "Unable to load overview"} />;
  const data = overview.data!;
  const closing = data.cash_minor;
  const opening = closing - data.income_minor + data.spending_minor;
  const movement = [opening, data.income_minor, data.spending_minor, 0, closing];
  const widths = movementWidths(movement);
  const trend = [
    { label: "Opening", value: opening }, { label: "Income", value: opening + data.income_minor },
    { label: "Spending", value: closing }, { label: "Closing", value: closing },
  ];
  return <Page title="Overview" note={`Position for ${month}`}>
    <section className="metric-line">
      <Metric label="Cash" value={formatMoney(data.cash_minor)} />
      <Metric label="Card liabilities" value={formatMoney(data.card_liabilities_minor)} tone="amber" />
      <Metric label="Net position" value={formatMoney(data.net_position_minor)} />
      <Metric label="Month net" value={formatMoney(data.income_minor - data.spending_minor)} tone={data.income_minor >= data.spending_minor ? "teal" : "red"} />
    </section>
    <section className="instrument-panel cash-panel">
      <div className="section-heading"><div><p className="eyebrow">Cash movement</p><h2>From opening to closing</h2></div><span>Transfers net to zero</span></div>
      <div className="cash-strip">{["Opening cash", "Income", "Spending", "Transfers", "Closing cash"].map((label, index) => <div className={`cash-segment segment-${index}`} style={{ flexGrow: widths[index] }} key={label}><span>{label}</span><strong>{formatMoney(movement[index])}</strong></div>)}</div>
    </section>
    <div className="two-column">
      <section className="instrument-panel"><div className="section-heading"><h2>Cash trend</h2><span>This month</span></div><div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={trend}><defs><linearGradient id="cashFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--teal)" stopOpacity={0.25}/><stop offset="95%" stopColor="var(--teal)" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="var(--line)"/><XAxis dataKey="label" tickLine={false} axisLine={false}/><YAxis hide/><Tooltip formatter={(value) => formatMoney(Number(value))}/><Area type="monotone" dataKey="value" stroke="var(--teal)" fill="url(#cashFill)" strokeWidth={2}/></AreaChart></ResponsiveContainer></div></section>
      <section className="instrument-panel"><div className="section-heading"><h2>Recent activity</h2><NavLink to="/transactions">View register</NavLink></div><div className="compact-list">{transactions.data!.items.map((item) => <div key={item.id}><span><strong>{item.merchant || item.description}</strong><small>{item.local_date} · {item.category || "Uncategorized"}</small></span><b className={item.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(item.amount_minor, item.currency)}</b></div>)}</div></section>
    </div>
  </Page>;
}

function AccountsPage() {
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Account>();
  const result = useData<Account[]>("/accounts", refresh);
  return <Page title="Accounts" note="Balances and reporting scope"><DataBoundary result={result}>{(accounts) => <>
    {["asset", "liability"].map((nature) => <section className="instrument-panel account-group" key={nature}><div className="section-heading"><h2>{nature === "asset" ? "Cash accounts" : "Credit accounts"}</h2><strong>{formatMoney(accounts.filter((a) => a.nature === nature).reduce((sum, a) => sum + (a.balance_minor || 0), 0))}</strong></div>{accounts.filter((a) => a.nature === nature).map((account) => <div className="account-row" key={account.id}><span className="account-mark">{account.name.slice(0, 2).toUpperCase()}</span><span><strong>{account.nickname || account.name}</strong><small>{account.subtype?.replace("_", " ")} · {account.status}</small></span><span className="scope-flags"><i className={account.include_budget ? "on" : ""}>Budget</i><i className={account.include_net ? "on" : ""}>Net</i><i className={account.include_export ? "on" : ""}>Export</i></span><b>{formatMoney(account.balance_minor || 0, account.currency)}</b><button className="quiet-button" onClick={() => setSelected(account)}>Edit</button></div>)}</section>)}{selected && <AccountEditor account={selected} onClose={() => setSelected(undefined)} onSaved={() => { setSelected(undefined); setRefresh((value) => value + 1); }} />}</>}</DataBoundary></Page>;
}

function TransactionsPage() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [splitTransaction, setSplitTransaction] = useState<Transaction>();
  const [message, setMessage] = useState("");
  const transactions = useData<{ items: Transaction[]; next_cursor?: string }>(`/transactions?limit=100${query ? `&search=${encodeURIComponent(query)}` : ""}`, refresh);
  const categories = useData<Category[]>("/categories", refresh);
  const transfers = useData<TransferCandidate[]>("/transfers/candidates", refresh);
  const columns = useMemo<ColumnDef<Transaction>[]>(() => [
    { id: "select", header: "", cell: ({ row }) => <input aria-label={`Select ${row.original.description}`} type="checkbox" checked={Boolean(selected[row.original.id])} onChange={(event) => setSelected({ ...selected, [row.original.id]: event.target.checked })} /> },
    { accessorKey: "local_date", header: "Date" },
    { accessorKey: "merchant", header: "Merchant", cell: ({ row }) => <span><strong>{row.original.merchant || row.original.description}</strong><small>{row.original.description}</small></span> },
    { accessorKey: "category", header: "Category", cell: ({ getValue }) => getValue<string>() || <span className="muted">Uncategorized</span> },
    { accessorKey: "notes", header: "Notes" },
    { accessorKey: "amount_minor", header: "Amount", cell: ({ row }) => <b className={row.original.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(row.original.amount_minor, row.original.currency)}</b> },
  ], [selected]);
  const table = useReactTable({ data: transactions.data?.items || [], columns, getCoreRowModel: getCoreRowModel() });
  async function categorize(categoryId: string) {
    const rows = (transactions.data?.items || []).filter((row) => selected[row.id]);
    await api("/transactions/bulk", { method: "POST", body: JSON.stringify({ items: rows.map((row) => ({ id: row.id, expected_updated_at: row.updated_at, category_id: categoryId })) }) });
    setSelected({}); setRefresh((value) => value + 1);
  }
  async function confirmTransfer(candidate: TransferCandidate) {
    await api(`/transfers/${candidate.transaction_a}/confirm`, { method: "POST", body: JSON.stringify({ transaction_a: candidate.transaction_a, transaction_b: candidate.transaction_b }) });
    setMessage("Transfer confirmed. Both sides are excluded from income and spending.");
    setRefresh((value) => value + 1);
  }
  const selectedRows = (transactions.data?.items || []).filter((row) => selected[row.id]);
  return <Page title="Transactions" note="Provider facts stay separate from your edits">
    <div className="sticky-tools"><form onSubmit={(event) => { event.preventDefault(); setQuery(search); }}><input aria-label="Search transactions" placeholder="Search merchant or description" value={search} onChange={(event) => setSearch(event.target.value)} /><button>Search</button></form><select aria-label="Categorize selected" defaultValue="" onChange={(event) => event.target.value && categorize(event.target.value)}><option value="">Categorize selected…</option>{categories.data?.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><button disabled={selectedRows.length !== 1} onClick={() => setSplitTransaction(selectedRows[0])}>Split</button><span>{selectedRows.length} selected</span></div>
    {message && <div className="notice success" role="status"><strong>Ledger updated.</strong><span>{message}</span></div>}
    {transfers.data && transfers.data.length > 0 && <section className="review-strip"><div><p className="eyebrow">Review</p><strong>{transfers.data.length} possible transfer{transfers.data.length === 1 ? "" : "s"}</strong></div>{transfers.data.slice(0, 3).map((candidate) => <div key={`${candidate.transaction_a}-${candidate.transaction_b}`}><span>{candidate.external_a} ↔ {candidate.external_b}<small>{candidate.confidence} confidence</small></span><button onClick={() => confirmTransfer(candidate)}>Confirm transfer</button></div>)}</section>}
    {transactions.loading ? <PageState text="Loading register…" /> : transactions.error ? <PageState error text={transactions.error} /> : <div className="table-wrap"><table className="register"><thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map((row) => <tr key={row.id}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table>{!table.getRowModel().rows.length && <PageState text="No transactions match these filters." />}</div>}
    {splitTransaction && <SplitEditor transaction={splitTransaction} categories={categories.data || []} onClose={() => setSplitTransaction(undefined)} onSaved={() => { setSplitTransaction(undefined); setSelected({}); setRefresh((value) => value + 1); }} />}
  </Page>;
}

function TrackingBudgetPage() {
  const [month, setMonth] = useState(currentMonth());
  const result = useData<TrackingRow[]>(`/budgets/tracking/${month}`);
  return <BudgetPage title="Tracking budget" month={month} setMonth={setMonth}><DataBoundary result={result}>{(rows) => rows.length ? <div className="budget-grid"><div className="budget-head"><span>Category</span><span>Target</span><span>Actual</span><span>Variance</span></div>{rows.map((row) => <div className="budget-row" key={row.category_id}><strong>{row.category}</strong><span>{formatMoney(row.target_minor)}</span><span>{formatMoney(row.actual_minor)}</span><b className={row.variance_minor < 0 ? "negative" : "positive"}>{formatMoney(row.variance_minor)}</b><div className="budget-bar"><i style={{ width: `${Math.min(100, row.target_minor ? (row.actual_minor / row.target_minor) * 100 : 0)}%` }}/></div></div>)}</div> : <Empty title="No targets for this month" text="Add tracking targets through the API while the editing controls are being configured." />}</DataBoundary></BudgetPage>;
}

function EnvelopeBudgetPage() {
  const [month, setMonth] = useState(currentMonth());
  const result = useData<EnvelopeData>(`/budgets/envelope/${month}`);
  return <BudgetPage title="Envelope budget" month={month} setMonth={setMonth}><DataBoundary result={result}>{(data) => <><div className="assign-pool"><span>Available to assign</span><strong>{formatMoney(data.available_to_assign_minor)}</strong></div>{data.categories.length ? <div className="budget-grid"><div className="budget-head"><span>Category</span><span>Allocated</span><span>Activity</span><span>Available</span></div>{data.categories.map((row) => <div className="budget-row" key={row.category_id}><strong>{row.category}</strong><span>{formatMoney(row.allocated_minor)}</span><span>{formatMoney(row.activity_minor)}</span><b className={row.available_minor < 0 ? "negative" : "positive"}>{formatMoney(row.available_minor)}</b></div>)}</div> : <Empty title="No envelopes yet" text="Allocations will appear here without changing the tracking budget." />}</>}</DataBoundary></BudgetPage>;
}

function ReportsPage() {
  const [month, setMonth] = useState(currentMonth());
  const flow = useData<{ income_minor: number; spending_minor: number; net_minor: number }>(`/reports/cash-flow?month=${month}`);
  const spending = useData<{ category: string; amount_minor: number }[]>(`/reports/spending?month=${month}`);
  return <Page title="Reports" note="Ledger-backed, USD combined totals"><MonthControl value={month} setValue={setMonth} /><DataBoundary result={flow}>{(data) => <section className="metric-line compact"><Metric label="Income" value={formatMoney(data.income_minor)} tone="teal"/><Metric label="Spending" value={formatMoney(data.spending_minor)} tone="red"/><Metric label="Net" value={formatMoney(data.net_minor)} /></section>}</DataBoundary><section className="instrument-panel"><div className="section-heading"><h2>Spending by category</h2><span>{month}</span></div><DataBoundary result={spending}>{(rows) => rows.length ? <div className="bar-list">{rows.map((row) => <div key={row.category}><span>{row.category}</span><i><b style={{ width: `${Math.max(3, (row.amount_minor / Math.max(...rows.map((item) => item.amount_minor))) * 100)}%` }} /></i><strong>{formatMoney(row.amount_minor)}</strong></div>)}</div> : <Empty title="No categorized spending" text="Categorized expenses for this month will appear here." />}</DataBoundary></section></Page>;
}

function RulesPage() {
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<RulePreview[]>([]);
  const [message, setMessage] = useState("");
  const rules = useData<Rule[]>("/rules", refresh);
  const categories = useData<Category[]>("/categories");
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/rules", { method: "POST", body: JSON.stringify({ name: form.get("name"), priority: Number(form.get("priority")), conditions: { description_contains: form.get("contains") }, category_id: form.get("category") }) });
    event.currentTarget.reset(); setMessage("Rule created. Existing transactions were not changed."); setRefresh((value) => value + 1);
  }
  async function previewRules() {
    const rows = await api<RulePreview[]>("/rules/preview", { method: "POST", body: "{}" });
    const matches = rows.reduce((total, row) => total + row.match_count, 0);
    setPreview(rows); setMessage(`${matches} eligible transaction${matches === 1 ? " matches" : "s match"} the current rules.`);
  }
  async function reprocess() {
    if (!window.confirm("Apply the first matching rule to all eligible transactions? This action is audited.")) return;
    const result = await api<{ applied_count: number }>("/rules/reprocess", { method: "POST", body: "{}" });
    setMessage(`${result.applied_count} transaction${result.applied_count === 1 ? " was" : "s were"} categorized.`); setPreview([]); setRefresh((value) => value + 1);
  }
  return <Page title="Rules" note="Lowest priority number wins">
    <div className="rule-layout">
      <section className="instrument-panel"><div className="section-heading"><div><p className="eyebrow">Deterministic categorization</p><h2>Ordered first-match rules</h2></div><div className="button-row"><button onClick={previewRules}>Preview</button><button disabled={!preview.length} onClick={reprocess}>Apply preview</button></div></div>{message && <p className="inline-message" role="status">{message}</p>}<DataBoundary result={rules}>{(items) => items.length ? <div className="rule-list">{items.map((rule) => <div key={rule.id}><b>{rule.priority}</b><span><strong>{rule.name}</strong><small>{describeRule(rule.conditions_json)} → {rule.category || rule.category_id}</small></span><i className={rule.enabled ? "on" : ""}>{rule.enabled ? "Enabled" : "Paused"}</i></div>)}</div> : <Empty title="No rules configured" text="Create a narrow rule below, then preview its effect before reprocessing history." />}</DataBoundary></section>
      <section className="instrument-panel rule-form"><div className="section-heading"><h2>Add rule</h2><span>AND conditions · category action</span></div><form onSubmit={create}><label>Name<input required name="name" maxLength={120} placeholder="Grocery market" /></label><label>Priority<input required name="priority" type="number" defaultValue={100} /></label><label>Description contains<input required name="contains" placeholder="MARKET" /></label><label>Assign category<select required name="category" defaultValue=""><option value="" disabled>Select category…</option>{categories.data?.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><button>Create without reprocessing</button></form></section>
    </div>
  </Page>;
}

function ConnectionsPage() {
  const [selected, setSelected] = useState<Connection>();
  const providers = useData<{ id: string; name: string; enabled: boolean }[]>("/providers");
  const connections = useData<Connection[]>("/connections");
  return <Page title="Connections" note="Synthetic data and Plaid Sandbox only"><div className="notice"><strong>Live access is locked.</strong><span>Production credentials require a separate rollout approval.</span></div><DataBoundary result={connections}>{(items) => <section className="instrument-panel"><div className="section-heading"><h2>Connected sources</h2><span>{items.length} total</span></div>{items.map((item) => <div className="connection-row" key={item.id}><span className={`connection-state ${item.status}`} /><span><strong>{item.provider}</strong><small>{item.last_success_at ? `Last synced ${item.last_success_at}` : "Never synced"}</small></span><b>{item.status}</b><button className="quiet-button" onClick={() => setSelected(item)}>Details</button></div>)}</section>}</DataBoundary><section className="provider-list"><DataBoundary result={providers}>{(items) => <>{items.map((item) => <div key={item.id}><span><strong>{item.name}</strong><small>{item.id === "synthetic" ? "Safe generated data" : "Transactions only"}</small></span><button disabled={!item.enabled}>{item.enabled ? "Available" : "Not configured"}</button></div>)}</>}</DataBoundary></section>{selected && <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelected(undefined)}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title"><div className="section-heading"><div><p className="eyebrow">Connection detail</p><h2 id="connection-title">{selected.provider}</h2></div><button className="quiet-button" onClick={() => setSelected(undefined)}>Close</button></div><div className="connection-detail"><span>Status<strong>{selected.status}</strong></span><span>Last successful sync<strong>{selected.last_success_at || "Not yet recorded"}</strong></span><span>Latest error<strong>{selected.last_error_code || "None"}</strong></span><p>Disconnect and repair controls remain unavailable for synthetic sources. Plaid Sandbox becomes available only after local sandbox credentials are configured.</p></div></section></div>}</Page>;
}

function SettingsPage({ dark, setDark }: { dark: boolean; setDark: (value: boolean) => void }) {
  const [operation, setOperation] = useState("");
  const settings = useData<Record<string, string | boolean>>("/settings");
  async function run(kind: "export" | "backup") {
    setOperation(`${kind === "export" ? "Export" : "Backup"} queued…`);
    const result = await api<{ job_id: string }>(kind === "export" ? "/exports" : "/backups", { method: "POST", body: kind === "export" ? JSON.stringify({ target: "excel" }) : "{}" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      const job = await api<{ status: string }>(`/jobs/${result.job_id}`);
      if (!['queued', 'running'].includes(job.status)) { setOperation(`${kind === "export" ? "Export" : "Backup"} ${job.status}.`); return; }
    }
    setOperation(`${kind === "export" ? "Export" : "Backup"} is still running.`);
  }
  return <Page title="Settings" note="Security and local automation"><DataBoundary result={settings}>{(data) => <div className="settings-list"><Setting label="Theme" text="Stored in this browser"><button onClick={() => setDark(!dark)}>{dark ? "Use light" : "Use dark"}</button></Setting><Setting label="Reporting" text={`${data.reporting_currency} · ${data.reporting_timezone}`}><span>Fixed for release 1</span></Setting><Setting label="Network" text="Dashboard listens only on 127.0.0.1"><span className="good">Local only</span></Setting><Setting label="Live-data readiness" text="Python 3.14, FileVault, encrypted backup, and approval are required"><span className="warning">Not ready</span></Setting><Setting label="Daily sync" text="06:17 local time and at login"><span>Mac must be awake</span></Setting><Setting label="Excel snapshot" text="Writes an atomic app-owned workbook"><button onClick={() => run("export")}>Export now</button></Setting><Setting label="Verified backup" text="SQLite online backup with integrity check"><button onClick={() => run("backup")}>Back up now</button></Setting>{operation && <div className="operation-status" role="status"><strong>Operation</strong><span>{operation}</span></div>}</div>}</DataBoundary></Page>;
}

function Page({ title, note, children }: { title: string; note: string; children: React.ReactNode }) { return <div className="page"><header className="page-title"><div><p className="eyebrow">FinTracka</p><h1>{title}</h1></div><p>{note}</p></header>{children}</div>; }
function BudgetPage({ title, month, setMonth, children }: { title: string; month: string; setMonth: (value: string) => void; children: React.ReactNode }) { return <Page title={title} note="One shared ledger, independent budget logic"><MonthControl value={month} setValue={setMonth} />{children}</Page>; }
function MonthControl({ value, setValue }: { value: string; setValue: (value: string) => void }) { return <div className="month-control"><label htmlFor="month">Month</label><input id="month" type="month" value={value} onChange={(event) => setValue(event.target.value)} /></div>; }
function Metric({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><strong>{title}</strong><p>{text}</p></div>; }
function PageState({ text, error = false }: { text: string; error?: boolean }) { return <div className={`page-state ${error ? "error" : ""}`}>{text}</div>; }
function Setting({ label, text, children }: { label: string; text: string; children: React.ReactNode }) { return <div><span><strong>{label}</strong><small>{text}</small></span>{children}</div>; }

function AccountEditor({ account, onClose, onSaved }: { account: Account; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState("");
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api(`/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify({ expected_updated_at: account.updated_at, nickname: form.get("nickname") || null, include_overview: form.has("overview"), include_budget: form.has("budget"), include_net: form.has("net"), include_export: form.has("export") }) });
      onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save account"); }
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="account-title"><div className="section-heading"><div><p className="eyebrow">Reporting scope</p><h2 id="account-title">{account.name}</h2></div><button className="quiet-button" onClick={onClose}>Close</button></div><form onSubmit={save}><label>Nickname<input name="nickname" defaultValue={account.nickname || ""} maxLength={120} /></label><fieldset className="check-grid"><legend>Include this account in</legend><label><input type="checkbox" name="overview" defaultChecked={Boolean(account.include_overview)} /> Overview</label><label><input type="checkbox" name="budget" defaultChecked={Boolean(account.include_budget)} /> Budgets</label><label><input type="checkbox" name="net" defaultChecked={Boolean(account.include_net)} /> Net position</label><label><input type="checkbox" name="export" defaultChecked={Boolean(account.include_export)} /> Exports</label></fieldset>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button>Save account</button></div></form></section></div>;
}

function SplitEditor({ transaction, categories, onClose, onSaved }: { transaction: Transaction; categories: Category[]; onClose: () => void; onSaved: () => void }) {
  const [firstMinor, setFirstMinor] = useState(Math.trunc(transaction.amount_minor / 2));
  const [firstCategory, setFirstCategory] = useState("");
  const [secondCategory, setSecondCategory] = useState("");
  const [error, setError] = useState("");
  const secondMinor = transaction.amount_minor - firstMinor;
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!firstMinor || !secondMinor) { setError("Both split amounts must be non-zero."); return; }
    try {
      await api(`/transactions/${transaction.id}/split`, { method: "POST", body: JSON.stringify({ expected_updated_at: transaction.updated_at, splits: [{ amount_minor: firstMinor, category_id: firstCategory || null }, { amount_minor: secondMinor, category_id: secondCategory || null }] }) });
      onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save split"); }
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="split-title"><div className="section-heading"><div><p className="eyebrow">Exact-sum editor</p><h2 id="split-title">Split {transaction.merchant || transaction.description}</h2></div><button className="quiet-button" onClick={onClose}>Close</button></div><form onSubmit={save}><p className="split-total">Parent total <strong>{formatMoney(transaction.amount_minor, transaction.currency)}</strong></p><label>First amount<input aria-label="First split amount" type="number" step="0.01" value={(firstMinor / 100).toFixed(2)} onChange={(event) => setFirstMinor(Math.round(Number(event.target.value) * 100))} /></label><label>First category<select value={firstCategory} onChange={(event) => setFirstCategory(event.target.value)}><option value="">Uncategorized</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Remaining amount<input aria-label="Remaining split amount" readOnly value={(secondMinor / 100).toFixed(2)} /></label><label>Remaining category<select value={secondCategory} onChange={(event) => setSecondCategory(event.target.value)}><option value="">Uncategorized</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button>Save exact split</button></div></form></section></div>;
}

function describeRule(source: string): string {
  try {
    const conditions = JSON.parse(source) as Record<string, string | number | boolean>;
    return Object.entries(conditions).map(([key, value]) => `${key.replaceAll("_", " ")} “${String(value)}”`).join(" and ");
  } catch { return "Invalid stored condition"; }
}

type DataResult<T> = { data?: T; loading: boolean; error?: string };
function DataBoundary<T>({ result, children }: { result: DataResult<T>; children: (data: T) => React.ReactNode }) { if (result.loading) return <PageState text="Reading the ledger…"/>; if (result.error) return <PageState error text={result.error}/>; return <>{children(result.data as T)}</>; }
function useData<T>(path: string, refresh = 0): DataResult<T> {
  const [result, setResult] = useState<DataResult<T>>({ loading: true });
  useEffect(() => { let current = true; setResult({ loading: true }); api<T>(path).then((data) => current && setResult({ data, loading: false })).catch((error: Error) => current && setResult({ loading: false, error: error.message })); return () => { current = false; }; }, [path, refresh]);
  return result;
}
