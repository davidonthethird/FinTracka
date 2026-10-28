import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { usePlaidLink } from "react-plaid-link";
import { ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Sankey, Tooltip, XAxis, YAxis } from "recharts";
import type { SankeyLinkProps, SankeyNodeProps } from "recharts";

import { api } from "./api";
import { currentMonth, currencyStep, formatMoney, majorInputToMinor, minorToMajorInput, movementWidths, totalsByCurrency } from "./format";
import { HistoryImportPage } from "./imports/HistoryImportPage";
import { PlanningPage } from "./planning/PlanningPage";
import { expenseNodeShares, FLOW_NODE_PADDING, flowChartHeight, splitLinksByOwner } from "./reports/flow";
import { SavingsPage } from "./savings/SavingsPage";
import { ManualCashDialog } from "./transactions/ManualCashDialog";
import { SubcategoryEditor, type Subcategory } from "./transactions/SubcategoryEditor";
import { CategorizationScopeControl } from "./transactions/CategorizationScopeControl";
import { effectiveCategorizationScope, readCategorizationScope, scopeMessage, writeCategorizationScope, type CategorizationScope } from "./transactions/categorization";

type OverviewData = { cash_minor: number; card_liabilities_minor: number; net_position_minor: number; income_minor: number; spending_minor: number; cash_income_minor: number; cash_spending_minor: number; cash_transfer_minor: number; off_bank_cash_spending_minor: number; opening_cash_minor: number | null };
type SpendingOwner = "David" | "Ariela" | "Shared";
type Account = { id: string; name: string; nickname?: string; nature: string; subtype?: string; currency: string; status: string; balance_minor?: number; include_overview: number; include_budget: number; include_net: number; include_export: number; include_savings: number; spending_owner: SpendingOwner; savings_pool?: "regular" | "retirement" | null; hidden: number; updated_at: string };
type Transaction = { id: string; account_id: string; account_name: string; account_nickname?: string; account_type: string; account_subtype?: string; account_mask?: string; provider: string; institution_name?: string; local_date: string; authorized_at?: string; posted_at?: string; amount_minor: number; currency: string; description: string; merchant?: string; category_id?: string; category?: string; category_source?: string; subcategory_id?: string; subcategory?: string; subcategory_source?: string; provider_category_primary?: string; provider_category_detailed?: string; provider_category_confidence?: string; spending_owner?: SpendingOwner; spending_owner_effective?: SpendingOwner; notes?: string; pending: boolean; manual_cash: boolean; is_cash_withdrawal: boolean; archived: boolean; updated_at: string };
type CategorizeResult = { transaction: Transaction; affected_count: number; undo_id: string };
type Category = { id: string; name: string; category_type: string; reporting_behavior: string; updated_at: string };
type TrackingRow = { category_id: string; category: string; target_minor: number; actual_minor: number; variance_minor: number };
type EnvelopeRow = { category_id: string; category: string; allocated_minor: number; activity_minor: number; available_minor: number };
type EnvelopeData = { month: string; starting_pool_minor: number; available_to_assign_minor: number; categories: EnvelopeRow[] };
type Rule = { id: string; name: string; priority: number; enabled: number; conditions_json: string; category_id: string; category?: string };
type RulePreview = { rule_id: string; name: string; priority: number; match_count: number };
type TransferCandidate = { transaction_a: string; transaction_b: string; external_a: string; external_b: string; label_a: string; label_b: string; date_a: string; date_b: string; amount_minor: number; currency: string; confidence: string };
type PlaidProfile = "david" | "ariela";
type PlaidProfileStatus = { id: PlaidProfile; label: string; configured: boolean; environment?: string };
type Connection = { id: string; provider: string; credential_profile?: PlaidProfile; environment?: string; institution_name?: string; status: string; last_success_at?: string; last_error_code?: string };
type Provider = { id: string; name: string; enabled: boolean; profiles?: PlaidProfileStatus[] };
type LinkSession = { link_token: string; expires_at: string; environment: string };
type ReadinessCheck = { id: string; label: string; status: "pass" | "fail" | "warning"; blocking: boolean; detail: string };
type ReadinessData = { ready: boolean; checks: ReadinessCheck[] };
type RemoteViewerStatus = { enabled: boolean; viewer_url?: string; history_months: number; interval_minutes: number; schedule_installed: boolean; schedule_loaded: boolean; last_source_sequence: number; last_bank_sync_at?: string; last_snapshot_id?: string; last_published_at?: string; last_error_code?: string; publication_count: number };
type FlowNode = { id: string; label: string; kind: string; amount_minor: number; entry_ids: string[]; totalBasisPoints?: number; ownerBasisPoints?: Partial<Record<SpendingOwner, number>> };
type FlowLink = { source: number; target: number; amount_minor: number; entry_ids: string[]; owner?: SpendingOwner };
type FlowEntry = { id: string; transaction_id: string; local_date: string; merchant: string; description: string; category: string; category_id?: string; amount_minor: number; currency: string; spending_owner?: SpendingOwner | null; notes?: string; updated_at: string; is_cash_withdrawal: boolean };
type FlowReport = { month: string; nodes: FlowNode[]; links: FlowLink[]; entries: FlowEntry[] };
type FlowSelection = { label: string; entry_ids: string[]; node_id?: string; source_id?: string; target_id?: string; owner?: SpendingOwner };
type OwnerSpending = { owner: SpendingOwner; amount_minor: number };

const nav = [
  ["/", "Overview"], ["/accounts", "Accounts"], ["/transactions", "Transactions"], ["/history-import", "History import"],
  ["/planning", "Planning"], ["/savings", "Savings"], ["/envelope-budget", "Envelope budget"],
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
        <Route path="/history-import" element={<HistoryImportPage />} />
        <Route path="/planning" element={<PlanningPage />} />
        <Route path="/savings" element={<SavingsPage />} />
        <Route path="/tracking-budget" element={<PlanningPage />} />
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
  const opening = data.opening_cash_minor;
  const movement = [opening ?? 0, data.cash_income_minor, data.cash_spending_minor, data.cash_transfer_minor, closing];
  const widths = movementWidths(movement);
  const movementPath = opening === null ? [] : [
    { label: "Opening", value: opening },
    { label: "Income", value: opening + data.cash_income_minor },
    { label: "Spending", value: opening + data.cash_income_minor - data.cash_spending_minor },
    { label: "Transfers", value: opening + data.cash_income_minor - data.cash_spending_minor + data.cash_transfer_minor },
  ];
  return <Page title="Overview" note={`Position for ${month}`}>
    <section className="metric-line">
      <Metric label="Cash" value={formatMoney(data.cash_minor)} />
      <Metric label="Card liabilities" value={formatMoney(data.card_liabilities_minor)} tone="amber" />
      <Metric label="Net position" value={formatMoney(data.net_position_minor)} />
      <Metric label="Month net" value={formatMoney(data.income_minor - data.spending_minor)} tone={data.income_minor >= data.spending_minor ? "teal" : "red"} />
    </section>
    {data.off_bank_cash_spending_minor > 0 && <div className="notice"><strong>Cash spending entered manually</strong><span>{formatMoney(data.off_bank_cash_spending_minor)} is included in spending but not in observed bank-balance movement.</span></div>}
    <section className="instrument-panel cash-panel">
      <div className="section-heading"><div><p className="eyebrow">Cash movement</p><h2>Observed opening and cash-account activity</h2></div><span>{opening === null ? "Opening balance history unavailable" : "Opening balance observed"}</span></div>
      <div className="cash-strip">{["Opening cash", "Cash income", "Cash spending", "Transfers", "Latest cash"].map((label, index) => <div className={`cash-segment segment-${index}`} style={{ flexGrow: widths[index] }} key={label}><span>{label}</span><strong>{index === 0 && opening === null ? "Unavailable" : formatMoney(movement[index])}</strong></div>)}</div>
    </section>
    <div className="two-column">
      <section className="instrument-panel"><div className="section-heading"><h2>Cash movement path</h2><span>This month</span></div>{movementPath.length ? <div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={movementPath}><defs><linearGradient id="cashFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--teal)" stopOpacity={0.25}/><stop offset="95%" stopColor="var(--teal)" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="var(--line)"/><XAxis dataKey="label" tickLine={false} axisLine={false}/><YAxis hide/><Tooltip formatter={(value) => formatMoney(Number(value))}/><Area type="monotone" dataKey="value" stroke="var(--teal)" fill="url(#cashFill)" strokeWidth={2}/></AreaChart></ResponsiveContainer></div> : <Empty title="Opening balance unavailable" text="The movement path will appear after balance history covers the start of this month." />}</section>
      <section className="instrument-panel"><div className="section-heading"><h2>Recent activity</h2><NavLink to="/transactions">View register</NavLink></div><div className="compact-list">{transactions.data!.items.map((item) => <div key={item.id}><span><strong>{item.merchant || item.description}</strong><small>{item.local_date} · {item.category || "Uncategorized"}</small></span><b className={item.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(item.amount_minor, item.currency)}</b></div>)}</div></section>
    </div>
  </Page>;
}

function AccountsPage() {
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Account>();
  const [showRemoved, setShowRemoved] = useState(false);
  const result = useData<Account[]>(`/accounts${showRemoved ? "?include_hidden=true" : ""}`, refresh);
  async function restore(account: Account) {
    await api(`/accounts/${account.id}/restore`, { method: "POST", body: "{}" });
    setRefresh((value) => value + 1);
  }
  return <Page title="Accounts" note="Balances and reporting scope"><label className="account-removed-toggle"><input type="checkbox" checked={showRemoved} onChange={(event) => setShowRemoved(event.target.checked)} /> Show removed accounts</label><DataBoundary result={result}>{(accounts) => <>
    {["asset", "liability"].map((nature) => { const group = accounts.filter((account) => account.nature === nature); const active = group.filter((account) => !account.hidden); return <section className="instrument-panel account-group" key={nature}><div className="section-heading"><h2>{nature === "asset" ? "Cash accounts" : "Credit accounts"}</h2><span className="account-totals">{totalsByCurrency(active).map((total) => <strong key={total.currency}>{formatMoney(total.minor, total.currency)}</strong>)}</span></div>{group.map((account) => <div className={`account-row ${account.hidden ? "removed" : ""}`} key={account.id}><span className="account-mark">{account.name.slice(0, 2).toUpperCase()}</span><span><strong>{account.nickname || account.name}</strong><small>{account.subtype?.replace("_", " ")} · {account.hidden ? "removed from FinTracka" : account.status}</small></span><span className="owner-badge">{account.spending_owner}</span><span className="scope-flags"><i className={account.include_budget ? "on" : ""}>Budget</i><i className={account.include_net ? "on" : ""}>Net</i><i className={account.include_export ? "on" : ""}>Export</i></span><b>{formatMoney(account.balance_minor || 0, account.currency)}</b>{account.hidden ? <button className="quiet-button" onClick={() => restore(account)}>Restore</button> : <button className="quiet-button" onClick={() => setSelected(account)}>Edit</button>}</div>)}</section>; })}{selected && <AccountEditor account={selected} onClose={() => setSelected(undefined)} onSaved={() => { setSelected(undefined); setRefresh((value) => value + 1); }} />}</>}</DataBoundary></Page>;
}

function TransactionsPage() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [subcategoryFilter, setSubcategoryFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [includeTransfers, setIncludeTransfers] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [pageRevision, setPageRevision] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [detailTransaction, setDetailTransaction] = useState<Transaction>();
  const [detailTransfer, setDetailTransfer] = useState<TransferCandidate>();
  const [splitTransaction, setSplitTransaction] = useState<Transaction>();
  const [message, setMessage] = useState("");
  const [learningScope, setLearningScope] = useState<CategorizationScope>(() => readCategorizationScope());
  const [undoId, setUndoId] = useState("");
  const [showAllTransfers, setShowAllTransfers] = useState(false);
  const [cashDialog, setCashDialog] = useState<Transaction | "new">();
  const transactions = useTransactionPages(query, categoryFilter, subcategoryFilter, ownerFilter, accountFilter, includeTransfers, includeArchived, `${refresh}:${pageRevision}`);
  const categories = useData<Category[]>("/categories", refresh);
  const subcategories = useData<Subcategory[]>("/subcategories", refresh);
  const accounts = useData<Account[]>("/accounts", refresh);
  const transfers = useData<TransferCandidate[]>("/transfers/candidates", refresh);
  const columns = useMemo<ColumnDef<Transaction>[]>(() => [
    { id: "select", header: "", cell: ({ row }) => <input aria-label={`Select ${row.original.description}`} type="checkbox" checked={Boolean(selected[row.original.id])} onChange={(event) => setSelected({ ...selected, [row.original.id]: event.target.checked })} /> },
    { accessorKey: "local_date", header: "Date" },
    { accessorKey: "merchant", header: "Merchant", cell: ({ row }) => <span><strong>{row.original.merchant || row.original.description}</strong><small>{row.original.description}</small></span> },
    { accessorKey: "category", header: "Category", cell: ({ row }) => <span className="category-cell"><select aria-label={`Category for ${row.original.merchant || row.original.description}`} value={row.original.category_id || ""} onChange={(event) => event.target.value && categorizeOne(row.original, event.target.value)}><option value="" disabled>Uncategorized</option>{categories.data?.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><small>{row.original.is_cash_withdrawal ? "Withdrawal · changes apply once" : categorySource(row.original)}</small><SubcategoryEditor transaction={row.original} category={categories.data?.find((category) => category.id === row.original.category_id)} scope={learningScope} onSaved={subcategorySaved} /></span> },
    { id: "spending_owner", header: "Spent by", cell: ({ row }) => row.original.spending_owner_effective ? <span className="owner-cell"><select aria-label={`Spent by for ${row.original.merchant || row.original.description}`} value={row.original.spending_owner || ""} onChange={(event) => changeSpendingOwner(row.original, event.target.value || null)}><option value="">Account default</option><option value="David">David</option><option value="Ariela">Ariela</option><option value="Shared">Shared</option></select><small>{row.original.spending_owner ? "Override" : row.original.spending_owner_effective}</small></span> : <span className="muted">—</span> },
    { accessorKey: "notes", header: "Notes" },
    { accessorKey: "amount_minor", header: "Amount", cell: ({ row }) => <b className={row.original.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(row.original.amount_minor, row.original.currency)}</b> },
    { id: "actions", header: "", cell: ({ row }) => <span className="row-actions">{row.original.manual_cash && !row.original.archived && <><button className="text-button" onClick={() => setCashDialog(row.original)}>Edit</button><button className="text-button destructive" onClick={() => deleteCash(row.original)}>Delete</button></>}<button className={`text-button ${row.original.archived ? "" : "destructive"}`} onClick={() => setArchived(row.original, !row.original.archived)}>{row.original.archived ? "Restore" : "Archive"}</button></span> },
  ], [selected, categories.data, learningScope]);
  const table = useReactTable({ data: transactions.data?.items || [], columns, getCoreRowModel: getCoreRowModel() });
  async function categorize(categoryId: string) {
    const rows = (transactions.data?.items || []).filter((row) => selected[row.id]);
    await api("/transactions/bulk", { method: "POST", body: JSON.stringify({ items: rows.map((row) => ({ id: row.id, expected_updated_at: row.updated_at, category_id: categoryId })) }) });
    setSelected({}); setRefresh((value) => value + 1);
  }
  async function categorizeOne(transaction: Transaction, categoryId: string) {
    try {
      const appliedScope = effectiveCategorizationScope(learningScope, transaction.is_cash_withdrawal);
      const result = await api<CategorizeResult>(`/transactions/${transaction.id}/categorize`, { method: "POST", body: JSON.stringify({ expected_updated_at: transaction.updated_at, category_id: categoryId, scope: appliedScope }) });
      setUndoId(result.undo_id);
      setMessage(`${result.affected_count} transaction${result.affected_count === 1 ? " was" : "s were"} categorized. ${scopeMessage(appliedScope)}`);
      setRefresh((value) => value + 1);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Unable to categorize transaction"); }
  }
  async function undoLastCategorization() {
    const result = await api<{ restored_count: number }>(`/categorizations/${undoId}/undo`, { method: "POST", body: "{}" });
    setMessage(`${result.restored_count} transaction${result.restored_count === 1 ? " was" : "s were"} restored.`);
    setUndoId(""); setRefresh((value) => value + 1);
  }
  function subcategorySaved(result: { affected_count: number; undo_id: string }, appliedScope: CategorizationScope) {
    setUndoId("");
    setMessage(`${result.affected_count} transaction${result.affected_count === 1 ? " was" : "s were"} updated. ${scopeMessage(appliedScope)}`);
    setRefresh((value) => value + 1);
  }
  async function changeSpendingOwner(transaction: Transaction, spendingOwner: string | null) {
    await api(`/transactions/${transaction.id}`, { method: "PATCH", body: JSON.stringify({ expected_updated_at: transaction.updated_at, spending_owner: spendingOwner }) });
    setMessage(`Spending assigned to ${spendingOwner || "the account default"}.`);
    setUndoId(""); setRefresh((value) => value + 1);
  }
  async function confirmTransfer(candidate: TransferCandidate) {
    await api(`/transfers/${candidate.transaction_a}/confirm`, { method: "POST", body: JSON.stringify({ transaction_a: candidate.transaction_a, transaction_b: candidate.transaction_b }) });
    setMessage("Transfer confirmed. Matching history and future pairs will be learned.");
    setRefresh((value) => value + 1);
  }
  async function rejectTransfer(candidate: TransferCandidate) {
    await api(`/transfers/${candidate.transaction_a}/reject`, { method: "POST", body: JSON.stringify({ transaction_a: candidate.transaction_a, transaction_b: candidate.transaction_b }) });
    setMessage("Both transactions will stay visible and continue to count.");
    setRefresh((value) => value + 1);
  }
  async function deleteCash(transaction: Transaction) {
    if (!window.confirm(`Delete ${transaction.description}? The audit history will be retained.`)) return;
    await api(`/transactions/${transaction.id}?expected_updated_at=${encodeURIComponent(transaction.updated_at)}`, { method: "DELETE" });
    setMessage("Manual cash spending deleted."); setRefresh((value) => value + 1);
  }
  async function setArchived(transaction: Transaction, archived: boolean) {
    if (archived && !window.confirm(`Archive ${transaction.merchant || transaction.description}? It will be removed from all financial totals and can be restored later.`)) return;
    await api(`/transactions/${transaction.id}`, { method: "PATCH", body: JSON.stringify({ expected_updated_at: transaction.updated_at, archived }) });
    setSelected((current) => ({ ...current, [transaction.id]: false }));
    setMessage(`Transaction ${archived ? "archived" : "restored"}.`);
    setUndoId(""); setRefresh((value) => value + 1);
  }
  const selectedRows = (transactions.data?.items || []).filter((row) => selected[row.id]);
  return <Page title="Transactions" note="Provider facts stay separate from your edits">
    <div className="sticky-tools">
      <div className="transaction-primary"><form onSubmit={(event) => { event.preventDefault(); transactions.cancelPending(); setQuery(search); setPageRevision((value) => value + 1); }}><input aria-label="Search transactions" placeholder="Search merchant, category, or subcategory" value={search} onChange={(event) => setSearch(event.target.value)} /><button>Search</button></form><button onClick={() => setCashDialog("new")}>Add cash spending</button></div>
      <div className="transaction-filters"><select aria-label="Filter by account" value={accountFilter} onChange={(event) => { transactions.cancelPending(); setSelected({}); setAccountFilter(event.target.value); }}><option value="">All accounts</option>{accounts.data?.filter((account) => !account.hidden).map((account) => <option key={account.id} value={account.id}>{account.nickname || account.name}</option>)}</select><select aria-label="Filter by category" value={categoryFilter} onChange={(event) => { transactions.cancelPending(); setSelected({}); setSubcategoryFilter(""); setCategoryFilter(event.target.value); }}><option value="">All categories</option><option value="review">Review uncertain</option><option value="uncategorized">Uncategorized</option>{categories.data?.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><select aria-label="Filter by subcategory" value={subcategoryFilter} onChange={(event) => { transactions.cancelPending(); setSelected({}); setSubcategoryFilter(event.target.value); }}><option value="">All subcategories</option>{subcategories.data?.filter((item) => !categoryFilter || item.category_id === categoryFilter).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select aria-label="Filter spending owner" value={ownerFilter} onChange={(event) => { transactions.cancelPending(); setSelected({}); setOwnerFilter(event.target.value); }}><option value="">Everyone</option><option value="David">David</option><option value="Ariela">Ariela</option><option value="Shared">Shared</option></select><CategorizationScopeControl value={learningScope} onChange={(scope) => { setLearningScope(scope); writeCategorizationScope(scope); }} /><select aria-label="Categorize selected" value="" disabled={!selectedRows.length} onChange={(event) => event.target.value && categorize(event.target.value)}><option value="">Categorize selected…</option>{categories.data?.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><button disabled={selectedRows.length !== 1} onClick={() => setSplitTransaction(selectedRows[0])}>Split</button><span>{selectedRows.length} selected</span><label className="transfer-toggle"><input type="checkbox" checked={includeTransfers} onChange={(event) => { transactions.cancelPending(); setSelected({}); setIncludeTransfers(event.target.checked); }} />Include confirmed transfers</label><label className="transfer-toggle"><input type="checkbox" checked={includeArchived} onChange={(event) => { transactions.cancelPending(); setSelected({}); setIncludeArchived(event.target.checked); }} />Include archived transactions</label></div>
    </div>
    {message && <div className="notice success" role="status"><strong>Ledger updated.</strong><span>{message}</span>{undoId && <button className="quiet-button" onClick={undoLastCategorization}>Undo</button>}</div>}
    {transfers.data && transfers.data.length > 0 && <section className={`review-strip ${showAllTransfers ? "expanded" : ""}`}><div><p className="eyebrow">Review</p><strong>{transfers.data.length} possible transfer{transfers.data.length === 1 ? "" : "s"}</strong>{transfers.data.length > 3 && <button className="text-button" onClick={() => setShowAllTransfers(!showAllTransfers)}>{showAllTransfers ? "Show fewer" : "Review all"}</button>}</div>{transfers.data.slice(0, showAllTransfers ? undefined : 3).map((candidate) => <div className="transfer-candidate" role="button" tabIndex={0} aria-label={`View transfer details for ${candidate.label_a} and ${candidate.label_b}`} key={`${candidate.transaction_a}-${candidate.transaction_b}`} onClick={(event) => { if (!(event.target as HTMLElement).closest("button")) setDetailTransfer(candidate); }} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !(event.target as HTMLElement).closest("button")) { event.preventDefault(); setDetailTransfer(candidate); } }}><span><strong>{candidate.label_a} ↔ {candidate.label_b}</strong><small>{candidate.date_a}–{candidate.date_b} · {formatMoney(candidate.amount_minor, candidate.currency)} · {candidate.confidence}</small></span><span className="transfer-actions"><button aria-label="Confirm transfer" title="Confirm and hide" onClick={() => confirmTransfer(candidate)}>✓</button><button aria-label="Keep visible" title="Keep visible" onClick={() => rejectTransfer(candidate)}>×</button></span></div>)}</section>}
    {transactions.loading ? <PageState text="Loading register…" /> : transactions.error ? <PageState error text={transactions.error} /> : <div className="table-wrap"><table className="register"><thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map((row) => <tr key={row.id} tabIndex={0} aria-label={`View ${row.original.merchant || row.original.description} transaction details`} className={`clickable-row${row.original.archived ? " archived-row" : ""}`} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input, select, a")) setDetailTransaction(row.original); }} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !(event.target as HTMLElement).closest("button, input, select, a")) { event.preventDefault(); setDetailTransaction(row.original); } }}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table>{!table.getRowModel().rows.length && <PageState text="No transactions match these filters." />}{transactions.data?.next_cursor && <div className="load-more"><button disabled={transactions.loadingMore} onClick={transactions.loadMore}>{transactions.loadingMore ? "Loading…" : "Load older transactions"}</button></div>}</div>}
    {splitTransaction && <SplitEditor transaction={splitTransaction} categories={categories.data || []} onClose={() => setSplitTransaction(undefined)} onSaved={() => { setSplitTransaction(undefined); setSelected({}); setRefresh((value) => value + 1); }} />}
    {cashDialog && <ManualCashDialog categories={categories.data || []} transaction={cashDialog === "new" ? undefined : cashDialog} onClose={() => setCashDialog(undefined)} onSaved={() => { setCashDialog(undefined); setRefresh((value) => value + 1); }} />}
    {detailTransaction && <TransactionDetails transaction={detailTransaction} onClose={() => setDetailTransaction(undefined)} />}
    {detailTransfer && <TransferDetails candidate={detailTransfer} onClose={() => setDetailTransfer(undefined)} />}
  </Page>;
}

function TransferDetails({ candidate, onClose }: { candidate: TransferCandidate; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [transactions, setTransactions] = useState<Transaction[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<Transaction>(`/transactions/${candidate.transaction_a}`, { signal: controller.signal }),
      api<Transaction>(`/transactions/${candidate.transaction_b}`, { signal: controller.signal }),
    ]).then((items) => setTransactions(items.sort((left, right) => left.amount_minor - right.amount_minor))).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load transfer details");
    });
    return () => controller.abort();
  }, [candidate.transaction_a, candidate.transaction_b]);
  useEffect(() => {
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <div className="flow-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="flow-drawer transfer-details" role="dialog" aria-modal="true" aria-label="Transfer comparison"><div className="section-heading"><div><p className="eyebrow">Possible transfer</p><h2>Compare both transactions</h2></div><button ref={closeButton} className="quiet-button" aria-label="Close transfer details" onClick={onClose}>Close</button></div>{error ? <PageState error text={error} /> : !transactions ? <PageState text="Loading both transactions…" /> : <div className="transfer-detail-cards">{transactions.map((transaction) => { const account = `${transaction.account_nickname || transaction.account_name}${transaction.account_mask ? ` •••• ${transaction.account_mask}` : ""}`; return <section className="transfer-detail-card" key={transaction.id}><div className="transaction-detail-summary"><span><b>{transaction.amount_minor < 0 ? "Money out" : "Money in"}</b><small>{transaction.local_date} · {transaction.pending ? "Pending" : "Posted"}</small></span><strong className={transaction.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(transaction.amount_minor, transaction.currency)}</strong></div><h3>{transaction.merchant || transaction.description}</h3><dl className="transaction-detail-list"><div><dt>Account</dt><dd>{account}</dd></div><div><dt>Institution</dt><dd>{transaction.institution_name || "Manual entry"}</dd></div><div><dt>Description</dt><dd>{transaction.description}</dd></div><div><dt>Category</dt><dd>{transaction.category || "Uncategorized"}{transaction.subcategory ? ` · ${transaction.subcategory}` : ""}</dd></div><div><dt>Spent by</dt><dd>{transaction.spending_owner_effective || "Not applicable"}</dd></div><div><dt>Status</dt><dd>{transaction.pending ? "Pending" : "Posted"}{transaction.archived ? " · Archived" : ""}</dd></div></dl></section>; })}</div>}</aside></div>;
}

function TransactionDetails({ transaction, onClose }: { transaction: Transaction; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const account = `${transaction.account_nickname || transaction.account_name}${transaction.account_mask ? ` •••• ${transaction.account_mask}` : ""}`;
  const category = transaction.category || "Uncategorized";
  const providerCategory = [transaction.provider_category_primary, transaction.provider_category_detailed].filter(Boolean).join(" · ").replaceAll("_", " ") || "Not provided";
  const timestamp = (value?: string) => value ? new Date(value).toLocaleString() : "Not provided";
  return <div className="flow-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="flow-drawer transaction-details" role="dialog" aria-modal="true" aria-label="Transaction details"><div className="section-heading"><div><p className="eyebrow">Transaction detail</p><h2>{transaction.merchant || transaction.description}</h2></div><button ref={closeButton} className="quiet-button" aria-label="Close transaction details" onClick={onClose}>Close</button></div><div className="transaction-detail-summary"><strong className={transaction.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(transaction.amount_minor, transaction.currency)}</strong><span>{transaction.local_date} · {transaction.pending ? "Pending" : "Posted"}{transaction.archived ? " · Archived" : ""}</span></div><dl className="transaction-detail-list"><div><dt>Account</dt><dd>{account}</dd></div><div><dt>Institution</dt><dd>{transaction.institution_name || "Manual entry"}</dd></div><div><dt>Account type</dt><dd>{[transaction.account_type, transaction.account_subtype].filter(Boolean).join(" · ").replaceAll("_", " ")}</dd></div><div><dt>Source</dt><dd>{transaction.manual_cash ? "Manual cash" : transaction.provider}</dd></div><div><dt>Description</dt><dd>{transaction.description}</dd></div><div><dt>Category</dt><dd>{category}{transaction.subcategory ? ` · ${transaction.subcategory}` : ""}</dd></div><div><dt>Category source</dt><dd>{transaction.category_source || "Not categorized"}</dd></div><div><dt>Spent by</dt><dd>{transaction.spending_owner_effective || "Not applicable"}{transaction.spending_owner ? " · override" : ""}</dd></div><div><dt>Authorized</dt><dd>{timestamp(transaction.authorized_at)}</dd></div><div><dt>Posted</dt><dd>{timestamp(transaction.posted_at)}</dd></div><div><dt>Provider category</dt><dd>{providerCategory}</dd></div><div><dt>Provider confidence</dt><dd>{transaction.provider_category_confidence?.replaceAll("_", " ") || "Not provided"}</dd></div><div><dt>Notes</dt><dd>{transaction.notes || "None"}</dd></div><div><dt>Flags</dt><dd>{[transaction.pending && "Pending", transaction.archived && "Archived", transaction.is_cash_withdrawal && "Cash withdrawal", transaction.manual_cash && "Manual cash"].filter(Boolean).join(" · ") || "None"}</dd></div><div><dt>FinTracka ID</dt><dd className="transaction-id">{transaction.id}</dd></div></dl></aside></div>;
}

function TrackingBudgetPage() {
  const [month, setMonth] = useState(currentMonth());
  const [refresh, setRefresh] = useState(0);
  const [message, setMessage] = useState("");
  const result = useData<TrackingRow[]>(`/budgets/tracking/${month}`, refresh);
  const categories = useData<Category[]>("/categories");
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api(`/budgets/tracking/${month}`, { method: "PUT", body: JSON.stringify({ category_id: form.get("category"), amount_minor: Math.round(Number(form.get("amount")) * 100) }) });
      formElement.reset(); setMessage("Tracking target saved."); setRefresh((value) => value + 1);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Unable to save tracking target"); }
  }
  return <BudgetPage title="Tracking budget" month={month} setMonth={setMonth}><BudgetEditor onSubmit={save} message={message}><label>Category<select required name="category" defaultValue=""><option value="" disabled>Select category…</option>{categories.data?.filter((category) => category.category_type === "expense").map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label>Monthly target<input required name="amount" type="number" min="0" step="0.01" placeholder="0.00" /></label><button>Save target</button></BudgetEditor><DataBoundary result={result}>{(rows) => rows.length ? <div className="budget-grid"><div className="budget-head"><span>Category</span><span>Target</span><span>Actual</span><span>Variance</span></div>{rows.map((row) => <div className="budget-row" key={row.category_id}><strong>{row.category}</strong><span>{formatMoney(row.target_minor)}</span><span>{formatMoney(row.actual_minor)}</span><b className={row.variance_minor < 0 ? "negative" : "positive"}>{formatMoney(row.variance_minor)}</b><div className="budget-bar"><i style={{ width: `${Math.min(100, row.target_minor ? (row.actual_minor / row.target_minor) * 100 : 0)}%` }}/></div></div>)}</div> : <Empty title="No targets for this month" text="Choose an expense category and save its monthly target above." />}</DataBoundary></BudgetPage>;
}

function EnvelopeBudgetPage() {
  const [month, setMonth] = useState(currentMonth());
  const [refresh, setRefresh] = useState(0);
  const [message, setMessage] = useState("");
  const result = useData<EnvelopeData>(`/budgets/envelope/${month}`, refresh);
  const categories = useData<Category[]>("/categories");
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api(`/budgets/envelope/${month}`, { method: "PUT", body: JSON.stringify({ starting_pool_minor: Math.round(Number(form.get("pool")) * 100), category_id: form.get("category"), allocation_minor: Math.round(Number(form.get("allocation")) * 100) }) });
      setMessage("Envelope allocation saved."); setRefresh((value) => value + 1);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Unable to save envelope allocation"); }
  }
  return <BudgetPage title="Envelope budget" month={month} setMonth={setMonth}><BudgetEditor key={`${month}-${result.data?.starting_pool_minor ?? "loading"}`} onSubmit={save} message={message}><label>Month pool<input required name="pool" type="number" step="0.01" defaultValue={result.data ? (result.data.starting_pool_minor / 100).toFixed(2) : "0.00"} /></label><label>Category<select required name="category" defaultValue=""><option value="" disabled>Select category…</option>{categories.data?.filter((category) => category.category_type === "expense").map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label>Allocation<input required name="allocation" type="number" step="0.01" placeholder="0.00" /></label><button>Save allocation</button></BudgetEditor><DataBoundary result={result}>{(data) => <><div className="assign-pool"><span>Available to assign</span><strong>{formatMoney(data.available_to_assign_minor)}</strong></div>{data.categories.length ? <div className="budget-grid"><div className="budget-head"><span>Category</span><span>Allocated</span><span>Activity</span><span>Available</span></div>{data.categories.map((row) => <div className="budget-row" key={row.category_id}><strong>{row.category}</strong><span>{formatMoney(row.allocated_minor)}</span><span>{formatMoney(row.activity_minor)}</span><b className={row.available_minor < 0 ? "negative" : "positive"}>{formatMoney(row.available_minor)}</b></div>)}</div> : <Empty title="No envelopes yet" text="Set the month's pool and allocate an expense category above." />}</>}</DataBoundary></BudgetPage>;
}

function ReportsPage() {
  const [month, setMonth] = useState(currentMonth());
  const [selection, setSelection] = useState<FlowSelection>();
  const [splitPeople, setSplitPeople] = useState(false);
  const [selectedOwner, setSelectedOwner] = useState<SpendingOwner>();
  const [revision, setRevision] = useState(0);
  const [categorizationScope, setCategorizationScope] = useState<CategorizationScope>(() => readCategorizationScope());
  const [categorizationFeedback, setCategorizationFeedback] = useState<{ tone: "status" | "error"; text: string }>();
  const [undoId, setUndoId] = useState("");
  const [drawerReport, setDrawerReport] = useState<FlowReport>();
  const flow = useData<{ income_minor: number; spending_minor: number; net_minor: number }>(`/reports/cash-flow?month=${month}`, revision);
  const paths = useData<FlowReport>(`/reports/flow?month=${month}`, revision);
  const spending = useData<{ category: string; amount_minor: number }[]>(`/reports/spending?month=${month}${selectedOwner ? `&spending_owner=${selectedOwner}` : ""}`, revision);
  const owners = useData<OwnerSpending[]>(`/reports/spending-owners?month=${month}`, revision);
  const categories = useData<Category[]>("/categories");
  useEffect(() => { setSelection(undefined); setSelectedOwner(undefined); setCategorizationFeedback(undefined); setUndoId(""); }, [month]);
  useEffect(() => { if (paths.data) setDrawerReport(paths.data); }, [paths.data]);
  useEffect(() => {
    if (!selection || !paths.data) return;
    let entryIds: string[] = [];
    if (selection.node_id) {
      entryIds = paths.data.nodes.find((node) => node.id === selection.node_id)?.entry_ids || [];
    } else if (selection.source_id && selection.target_id) {
      const links = splitPeople ? splitLinksByOwner(paths.data) : paths.data.links;
      const link = links.find((item) => paths.data!.nodes[Number(item.source)]?.id === selection.source_id
        && paths.data!.nodes[Number(item.target)]?.id === selection.target_id
        && item.owner === selection.owner);
      entryIds = link?.entry_ids || [];
    }
    if (entryIds.length !== selection.entry_ids.length || entryIds.some((id, index) => id !== selection.entry_ids[index])) {
      setSelection({ ...selection, entry_ids: entryIds });
    }
  }, [paths.data, selection, splitPeople]);
  function toggleSplit(value: boolean) { setSplitPeople(value); if (!value) setSelectedOwner(undefined); }
  function changeCategorizationScope(scope: CategorizationScope) { setCategorizationScope(scope); writeCategorizationScope(scope); }
  async function categorizeEntry(entry: FlowEntry, categoryId: string): Promise<boolean> {
    try {
      const appliedScope = effectiveCategorizationScope(categorizationScope, entry.is_cash_withdrawal);
      const result = await api<CategorizeResult>(`/transactions/${entry.transaction_id}/categorize`, { method: "POST", body: JSON.stringify({ expected_updated_at: entry.updated_at, category_id: categoryId, scope: appliedScope }) });
      setUndoId(result.undo_id);
      setCategorizationFeedback({ tone: "status", text: `${result.affected_count} transaction${result.affected_count === 1 ? " was" : "s were"} categorized. ${scopeMessage(appliedScope)}` });
      setRevision((value) => value + 1);
      return true;
    } catch (caught) {
      setCategorizationFeedback({ tone: "error", text: caught instanceof Error ? caught.message : "Unable to categorize transaction" });
      return false;
    }
  }
  async function undoCategorization() {
    if (!undoId) return;
    try {
      const result = await api<{ restored_count: number }>(`/categorizations/${undoId}/undo`, { method: "POST", body: "{}" });
      setUndoId("");
      setCategorizationFeedback({ tone: "status", text: `${result.restored_count} transaction${result.restored_count === 1 ? " was" : "s were"} restored.` });
      setRevision((value) => value + 1);
    } catch (caught) { setCategorizationFeedback({ tone: "error", text: caught instanceof Error ? caught.message : "Unable to undo categorization" }); }
  }
  return <Page title="Reports" note="Ledger-backed, USD combined totals"><div className="reports-controls"><MonthControl value={month} setValue={setMonth} /><label><input type="checkbox" checked={splitPeople} onChange={(event) => toggleSplit(event.target.checked)} /> Split spending by person</label></div><DataBoundary result={flow}>{(data) => <section className="metric-line compact"><Metric label="Income" value={formatMoney(data.income_minor)} tone="teal"/><Metric label="Spending" value={formatMoney(data.spending_minor)} tone="red"/><Metric label="Net" value={formatMoney(data.net_minor)} /></section>}</DataBoundary>{splitPeople && <section className="instrument-panel"><div className="section-heading"><h2>Spending by person</h2><button className="quiet-button" aria-pressed={!selectedOwner} onClick={() => setSelectedOwner(undefined)}>Everyone</button></div><DataBoundary result={owners}>{(rows) => { const total = rows.reduce((sum, row) => sum + row.amount_minor, 0); return <div className="owner-spending">{(["David", "Ariela", "Shared"] as SpendingOwner[]).map((owner) => { const amount = rows.find((row) => row.owner === owner)?.amount_minor || 0; return <button className={`owner-${owner.toLowerCase()} ${selectedOwner === owner ? "selected" : ""}`} aria-pressed={selectedOwner === owner} key={owner} onClick={() => setSelectedOwner(selectedOwner === owner ? undefined : owner)}><span>{owner}<small>{total ? `${((amount / total) * 100).toFixed(0)}% of spending` : "No spending"}</small></span><strong>{formatMoney(amount)}</strong></button>; })}</div>; }}</DataBoundary></section>}{selectedOwner && <OwnerTransactions owner={selectedOwner} month={month} />}<section className="instrument-panel flow-panel"><div className="section-heading"><div><h2>Income and spending flow</h2><small>{splitPeople ? "Blue: David · Pink: Ariela · Purple: Shared" : "Select a stream to inspect its transactions"}</small></div><span>{month}</span></div><DataBoundary result={paths}>{(report) => report.links.length ? <CashFlowDiagram report={report} onSelect={(next) => { setSelection(next); setCategorizationFeedback(undefined); setUndoId(""); }} splitByOwner={splitPeople} /> : <Empty title="No monthly flow yet" text="Income and spending paths will appear when this month has posted transactions." />}</DataBoundary></section><section className={`instrument-panel ${selectedOwner ? `owner-${selectedOwner.toLowerCase()}` : ""}`}><div className="section-heading"><h2>Spending by category{selectedOwner ? ` · ${selectedOwner}` : ""}</h2><span>{month}</span></div><DataBoundary result={spending}>{(rows) => rows.length ? <div className="bar-list">{rows.map((row) => <div key={row.category}><span>{row.category}</span><i><b style={{ width: `${Math.max(3, (row.amount_minor / Math.max(...rows.map((item) => item.amount_minor))) * 100)}%` }} /></i><strong>{formatMoney(row.amount_minor)}</strong></div>)}</div> : <Empty title="No categorized spending" text="Categorized expenses for this month will appear here." />}</DataBoundary></section>{selection && drawerReport && <FlowDrawer selection={selection} entries={drawerReport.entries} categories={(categories.data || []).filter((category) => category.category_type !== "transfer")} scope={categorizationScope} feedback={categorizationFeedback} undoAvailable={Boolean(undoId)} onScopeChange={changeCategorizationScope} onCategorize={categorizeEntry} onUndo={undoCategorization} onClose={() => setSelection(undefined)} />}</Page>;
}

function OwnerTransactions({ owner, month }: { owner: SpendingOwner; month: string }) {
  const result = useData<{ items: Transaction[] }>(`/transactions?limit=200&spending_owner=${owner}&month=${month}`);
  return <section className={`instrument-panel owner-${owner.toLowerCase()}`}><div className="section-heading"><h2>{owner} transactions</h2><span>{month}</span></div><DataBoundary result={result}>{(data) => data.items.length ? <div className="compact-list">{data.items.map((item) => <div key={item.id}><span><strong>{item.merchant || item.description}</strong><small>{item.local_date} · {item.category || "Uncategorized"}</small></span><b className="negative">{formatMoney(item.amount_minor, item.currency)}</b></div>)}</div> : <Empty title={`No ${owner} spending`} text="No expense transactions are assigned to this person for this month." />}</DataBoundary></section>;
}

function RulesPage() {
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<RulePreview[]>([]);
  const [message, setMessage] = useState("");
  const rules = useData<Rule[]>("/rules", refresh);
  const categories = useData<Category[]>("/categories");
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api("/rules", { method: "POST", body: JSON.stringify({ name: form.get("name"), priority: Number(form.get("priority")), conditions: { description_contains: form.get("contains") }, category_id: form.get("category") }) });
      formElement.reset(); setMessage("Rule created. Existing transactions were not changed."); setRefresh((value) => value + 1);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Unable to create rule"); }
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
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Connection>();
  const [refresh, setRefresh] = useState(0);
  const [link, setLink] = useState<{ session: LinkSession; mode: "connect" | "repair"; profile?: PlaidProfile }>();
  const [message, setMessage] = useState("");
  const providers = useData<Provider[]>("/providers", refresh);
  const connections = useData<Connection[]>("/connections", refresh);
  const plaid = providers.data?.find((provider) => provider.id === "plaid");

  async function beginConnect(profile: PlaidProfile) {
    setMessage("Creating a secure Plaid session…");
    try {
      const session = await api<LinkSession>("/connections/plaid/sessions", { method: "POST", body: JSON.stringify({ profile }) });
      setLink({ session, mode: "connect", profile });
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Unable to start Plaid Link"); }
  }
  async function beginRepair(connection: Connection) {
    setMessage("Creating a secure repair session…");
    try {
      const session = await api<LinkSession>(`/connections/${connection.id}/repair`, { method: "POST", body: "{}" });
      setSelected(undefined); setLink({ session, mode: "repair" });
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Unable to repair connection"); }
  }
  async function syncNow(destination?: string) {
    setMessage("Sync queued…");
    const result = await api<{ job_id: string }>("/sync-runs", { method: "POST", body: "{}" });
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      const job = await api<{ status: string }>(`/jobs/${result.job_id}`);
      if (job.status === "succeeded") { setMessage("Sync completed."); setRefresh((value) => value + 1); if (destination) navigate(destination); return; }
      if (!['queued', 'running'].includes(job.status)) throw new Error("Sync failed. Open connection details for the required action.");
    }
    setMessage("Sync is still running. You can leave this page safely.");
  }
  async function linkSucceeded(publicToken: string | null) {
    const mode = link?.mode;
    const profile = link?.profile;
    setLink(undefined);
    try {
      if (mode === "connect") {
        if (!publicToken) throw new Error("Plaid did not return a connection token.");
        if (!profile) throw new Error("Choose a Plaid profile before connecting.");
        await api<Connection>("/connections/plaid/complete", { method: "POST", body: JSON.stringify({ public_token: publicToken, profile }) });
        await syncNow("/accounts");
      } else {
        await syncNow();
      }
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Unable to finish the bank connection"); }
  }
  async function disconnect(connection: Connection) {
    if (!window.confirm(`Disconnect ${connection.institution_name || "this bank"}? Imported history will remain in FinTracka.`)) return;
    try {
      await api(`/connections/${connection.id}`, { method: "DELETE" });
      setSelected(undefined); setMessage("Bank access revoked. Imported history was preserved."); setRefresh((value) => value + 1);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Unable to disconnect bank"); }
  }
  return <Page title="Connections" note="Transactions-only bank access">
    <div className="notice"><strong>Live testing mode.</strong><span>Start with one institution and reconcile it before adding another. Bank credentials stay inside Plaid Link.</span></div>
    {message && <div className="operation-status connection-operation" role="status"><strong>Connection</strong><span>{message}</span></div>}
    <DataBoundary result={connections}>{(items) => <section className="instrument-panel"><div className="section-heading"><h2>Connected sources</h2><div className="button-row"><span>{items.length} total</span>{items.some((item) => item.provider === "plaid" && item.status === "active") && <button onClick={() => syncNow().catch((caught) => setMessage(caught instanceof Error ? caught.message : "Unable to sync"))}>Sync now</button>}</div></div>{items.map((item) => <div className="connection-row" key={item.id}><span className={`connection-state ${item.status}`} /><span><strong>{item.institution_name || item.provider}</strong><small>{item.last_success_at ? `Last synced ${item.last_success_at}` : `${item.environment || "local"} · Never synced`}</small>{item.provider === "plaid" && item.credential_profile && <small>Plaid profile: {item.credential_profile === "david" ? "David" : "Ariela"}</small>}</span><b>{item.status}</b><button className="quiet-button" onClick={() => setSelected(item)}>Details</button></div>)}</section>}</DataBoundary>
    <section className="provider-list"><DataBoundary result={providers}>{(items) => <>{items.map((item) => item.id === "plaid" ? <div className="provider-block" key={item.id}><span><strong>{item.name}</strong><small>Transactions only</small></span><div className="profile-options">{item.profiles?.map((profile) => <div className="profile-row" key={profile.id}><span><strong>{profile.label}</strong><small>{profile.configured ? profile.environment : "Not configured"}</small></span><button aria-label={`Connect bank as ${profile.label}`} disabled={!profile.configured || Boolean(link)} onClick={() => beginConnect(profile.id)}>{profile.configured ? "Connect bank" : "Not configured"}</button></div>)}</div></div> : <div key={item.id}><span><strong>{item.name}</strong><small>Safe generated data</small></span><span className="good">Available</span></div>)}</>}</DataBoundary></section>
    {link && <PlaidLinkLauncher session={link.session} onSuccess={linkSucceeded} onExit={(error) => { setLink(undefined); setMessage(error || "Plaid Link closed without changes."); }} />}
    {selected && <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelected(undefined)}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title"><div className="section-heading"><div><p className="eyebrow">Connection detail</p><h2 id="connection-title">{selected.institution_name || selected.provider}</h2></div><button className="quiet-button" onClick={() => setSelected(undefined)}>Close</button></div><div className="connection-detail"><span>Status<strong>{selected.status}</strong></span>{selected.credential_profile && <span>Plaid profile<strong>{selected.credential_profile === "david" ? "David" : "Ariela"}</strong></span>}<span>Environment<strong>{selected.environment || "Local"}</strong></span><span>Last successful sync<strong>{selected.last_success_at || "Not yet recorded"}</strong></span><span>Latest error<strong>{selected.last_error_code || "None"}</strong></span>{selected.provider === "plaid" && selected.status !== "revoked" ? <div className="dialog-actions"><button className="quiet-button destructive" onClick={() => disconnect(selected)}>Disconnect</button><button onClick={() => beginRepair(selected)}>Manage bank accounts</button></div> : <p>Synthetic and revoked sources retain their imported ledger history.</p>}</div></section></div>}
    {plaid && !plaid.profiles?.some((profile) => profile.configured) && <p className="provider-help">Configure a Plaid profile locally before connecting a bank. No credential is stored in this browser or repository.</p>}
  </Page>;
}

function PlaidLinkLauncher({ session, onSuccess, onExit }: { session: LinkSession; onSuccess: (token: string | null) => void; onExit: (error?: string) => void }) {
  const opened = useRef(false);
  const { open, ready, error } = usePlaidLink({
    token: session.link_token,
    onSuccess: (publicToken) => onSuccess(publicToken),
    onExit: (plaidError) => onExit(plaidError?.display_message || (plaidError ? `Plaid could not continue (${plaidError.error_code}).` : undefined)),
  });
  useEffect(() => {
    if (ready && !opened.current) { opened.current = true; open(); }
  }, [ready, open]);
  useEffect(() => { if (error) onExit("Plaid Link could not load. Check the local Content Security Policy and network connection."); }, [error, onExit]);
  return <span className="plaid-launch-state" role="status">Opening Plaid Link for {session.environment}…</span>;
}

function SettingsPage({ dark, setDark }: { dark: boolean; setDark: (value: boolean) => void }) {
  const [operation, setOperation] = useState("");
  const [refresh, setRefresh] = useState(0);
  const settings = useData<Record<string, string | boolean>>("/settings", refresh);
  const readiness = useData<ReadinessData>("/settings/readiness", refresh);
  const remote = useData<RemoteViewerStatus>("/settings/remote", refresh);
  async function run(kind: "excel" | "backup" | "google_authorize" | "google_export") {
    const labels = { excel: "Excel export", backup: "Backup", google_authorize: "Google authorization", google_export: "Google export" };
    setOperation(`${labels[kind]} queued…`);
    const paths = { excel: "/exports", backup: "/backups", google_authorize: "/exports/google/authorize", google_export: "/exports" };
    const bodies = { excel: JSON.stringify({ target: "excel" }), backup: "{}", google_authorize: "{}", google_export: JSON.stringify({ target: "google_sheets" }) };
    const result = await api<{ job_id: string }>(paths[kind], { method: "POST", body: bodies[kind] });
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      const job = await api<{ status: string }>(`/jobs/${result.job_id}`);
      if (!['queued', 'running'].includes(job.status)) { setOperation(`${labels[kind]} ${job.status}.`); setRefresh((value) => value + 1); return; }
    }
    setOperation(`${labels[kind]} is still running.`);
  }
  async function changeSchedule(installed: boolean) {
    setOperation(installed ? "Installing daily sync…" : "Removing daily sync…");
    try {
      await api("/settings/schedule", { method: installed ? "POST" : "DELETE", body: installed ? "{}" : undefined });
      setOperation(installed ? "Daily sync installed." : "Daily sync removed."); setRefresh((value) => value + 1);
    } catch (caught) { setOperation(caught instanceof Error ? caught.message : "Unable to change daily sync"); }
  }
  async function runRemote(kind: "publish" | "purge") {
    if (kind === "purge" && window.prompt("Type DELETE REMOTE COPY to remove the hosted snapshot.") !== "DELETE REMOTE COPY") return;
    const label = kind === "publish" ? "Remote publication" : "Remote deletion";
    setOperation(`${label} queued…`);
    try {
      const result = await api<{ job_id: string }>(kind === "publish" ? "/settings/remote/publish" : "/settings/remote/snapshot", { method: kind === "publish" ? "POST" : "DELETE", body: kind === "publish" ? "{}" : JSON.stringify({ confirmation: "DELETE REMOTE COPY" }) });
      for (let attempt = 0; attempt < 600; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const job = await api<{ status: string }>(`/jobs/${result.job_id}`);
        if (!['queued', 'running'].includes(job.status)) { setOperation(`${label} ${job.status}.`); setRefresh((value) => value + 1); return; }
      }
      setOperation(`${label} is still running.`);
    } catch (caught) { setOperation(caught instanceof Error ? caught.message : `${label} failed.`); }
  }
  async function changeRemoteSchedule(installed: boolean) {
    setOperation(installed ? "Installing hourly remote publication…" : "Removing remote publication schedule…");
    try {
      await api("/settings/remote/schedule", { method: installed ? "POST" : "DELETE", body: installed ? "{}" : undefined });
      setOperation(installed ? "Remote publication schedule installed." : "Remote publication schedule removed.");
      setRefresh((value) => value + 1);
    } catch (caught) { setOperation(caught instanceof Error ? caught.message : "Unable to change remote publication schedule."); }
  }
  return <Page title="Settings" note="Security and local automation"><DataBoundary result={readiness}>{(report) => <section className="instrument-panel readiness-panel"><div className="section-heading"><h2>Live-data readiness</h2><strong className={report.ready ? "good" : "warning"}>{report.ready ? "Ready for one-bank testing" : "Blocking checks remain"}</strong></div><div className="readiness-grid">{report.checks.map((check) => <div key={check.id} className={check.status}><span aria-hidden="true">{check.status === "pass" ? "✓" : check.status === "fail" ? "×" : "!"}</span><p><strong>{check.label}</strong><small>{check.detail}</small></p><b>{check.blocking ? "Required" : "Advisory"}</b></div>)}</div></section>}</DataBoundary><DataBoundary result={remote}>{(data) => <section className="instrument-panel remote-settings"><div className="section-heading"><div><p className="eyebrow">Private read-only copy</p><h2>Remote viewer</h2></div><strong className={data.enabled ? "good" : "warning"}>{data.enabled ? "Configured" : "Not configured"}</strong></div><div className="notice"><strong>Privacy boundary.</strong><span>The hosted viewer contains a sanitized financial snapshot. It cannot edit FinTracka or connect back to this Mac.</span></div><div className="remote-status-grid"><span>Latest bank sync<strong>{data.last_bank_sync_at || "Not available"}</strong></span><span>Latest cloud publish<strong>{data.last_published_at || "Not published"}</strong></span><span>Source sequence<strong>{data.last_source_sequence || "None"}</strong></span><span>Hourly schedule<strong>{data.schedule_loaded ? "Active" : data.schedule_installed ? "Installed, not loaded" : "Not installed"}</strong></span></div>{data.last_error_code && <p className="remote-error">Latest error: {data.last_error_code}</p>}<div className="remote-actions">{data.viewer_url ? <a className="button-link" href={data.viewer_url} target="_blank" rel="noreferrer">Open viewer</a> : <button disabled>Open viewer</button>}<button disabled={!data.enabled} onClick={() => changeRemoteSchedule(!data.schedule_installed)}>{data.schedule_installed ? "Remove hourly publishing" : "Install hourly publishing"}</button><button disabled={!data.enabled} onClick={() => runRemote("publish")}>Publish now</button><button className="destructive" disabled={!data.enabled} onClick={() => runRemote("purge")}>Delete remote copy</button></div></section>}</DataBoundary><DataBoundary result={settings}>{(data) => <div className="settings-list"><Setting label="Theme" text="Stored in this browser"><button onClick={() => setDark(!dark)}>{dark ? "Use light" : "Use dark"}</button></Setting><Setting label="Reporting" text={`${data.reporting_currency} · ${data.reporting_timezone}`}><span>Fixed for release 1</span></Setting><Setting label="Network" text="Dashboard listens only on 127.0.0.1"><span className="good">Local only</span></Setting><Setting label="Daily sync" text="06:17 local time and at login; the Mac must be awake"><button onClick={() => changeSchedule(!data.schedule_installed)}>{data.schedule_installed ? "Remove schedule" : "Install schedule"}</button></Setting><Setting label="Google Sheets" text="One-way export with access only to the workbook FinTracka creates">{data.google_authorized ? <button onClick={() => run("google_export")}>Export to Google</button> : <button disabled={!data.google_configured} onClick={() => run("google_authorize")}>{data.google_configured ? "Authorize Google" : "Not configured"}</button>}</Setting><Setting label="Excel snapshot" text="Writes an atomic app-owned workbook"><button onClick={() => run("excel")}>Export now</button></Setting><Setting label="Verified backup" text="SQLite online backup with integrity check"><button onClick={() => run("backup")}>Back up now</button></Setting>{operation && <div className="operation-status" role="status"><strong>Operation</strong><span>{operation}</span></div>}</div>}</DataBoundary></Page>;
}

function Page({ title, note, children }: { title: string; note: string; children: React.ReactNode }) { return <div className="page"><header className="page-title"><div><p className="eyebrow">FinTracka</p><h1>{title}</h1></div><p>{note}</p></header>{children}</div>; }
function BudgetPage({ title, month, setMonth, children }: { title: string; month: string; setMonth: (value: string) => void; children: React.ReactNode }) { return <Page title={title} note="One shared ledger, independent budget logic"><MonthControl value={month} setValue={setMonth} />{children}</Page>; }
function MonthControl({ value, setValue }: { value: string; setValue: (value: string) => void }) { return <div className="month-control"><label htmlFor="month">Month</label><input id="month" type="month" value={value} onChange={(event) => setValue(event.target.value)} /></div>; }
function Metric({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><strong>{title}</strong><p>{text}</p></div>; }
function PageState({ text, error = false }: { text: string; error?: boolean }) { return <div className={`page-state ${error ? "error" : ""}`}>{text}</div>; }
function Setting({ label, text, children }: { label: string; text: string; children: React.ReactNode }) { return <div><span><strong>{label}</strong><small>{text}</small></span>{children}</div>; }
function BudgetEditor({ onSubmit, message, children }: { onSubmit: (event: React.FormEvent<HTMLFormElement>) => void | Promise<void>; message: string; children: React.ReactNode }) { return <section className="instrument-panel budget-editor"><form onSubmit={onSubmit}>{children}</form>{message && <p className="inline-message" role="status">{message}</p>}</section>; }

function AccountEditor({ account, onClose, onSaved }: { account: Account; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState("");
  async function remove() {
    if (!window.confirm(`Remove ${account.nickname || account.name} from FinTracka? Its imported history will be hidden, not deleted, and you can restore it later.`)) return;
    try {
      await api(`/accounts/${account.id}`, { method: "DELETE" });
      onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to remove account"); }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api(`/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify({ expected_updated_at: account.updated_at, nickname: form.get("nickname") || null, spending_owner: form.get("spending_owner"), savings_pool: form.get("savings_pool") || null, include_overview: form.has("overview"), include_budget: form.has("budget"), include_net: form.has("net"), include_export: form.has("export"), include_savings: form.has("savings") }) });
      onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save account"); }
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="account-title"><div className="section-heading"><div><p className="eyebrow">Reporting scope</p><h2 id="account-title">{account.name}</h2></div><button className="quiet-button" onClick={onClose}>Close</button></div><form onSubmit={save}><label>Nickname<input name="nickname" defaultValue={account.nickname || ""} maxLength={120} /></label><label>Spending owner<select name="spending_owner" defaultValue={account.spending_owner}><option value="David">David</option><option value="Ariela">Ariela</option><option value="Shared">Shared</option></select></label><label>Savings pool<select name="savings_pool" defaultValue={account.savings_pool || ""}><option value="">Not tracked in a goal pool</option><option value="regular">Regular savings</option><option value="retirement">Retirement</option></select></label><fieldset className="check-grid"><legend>Include this account in</legend><label><input type="checkbox" name="overview" defaultChecked={Boolean(account.include_overview)} /> Overview</label><label><input type="checkbox" name="budget" defaultChecked={Boolean(account.include_budget)} /> Budgets</label><label><input type="checkbox" name="net" defaultChecked={Boolean(account.include_net)} /> Net position</label><label><input type="checkbox" name="export" defaultChecked={Boolean(account.include_export)} /> Exports</label><label><input type="checkbox" name="savings" defaultChecked={Boolean(account.include_savings)} /> Savings</label></fieldset>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions account-dialog-actions"><button type="button" className="quiet-button destructive" onClick={remove}>Remove from FinTracka</button><span /><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button>Save account</button></div></form></section></div>;
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
  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="split-title"><div className="section-heading"><div><p className="eyebrow">Exact-sum editor</p><h2 id="split-title">Split {transaction.merchant || transaction.description}</h2></div><button className="quiet-button" onClick={onClose}>Close</button></div><form onSubmit={save}><p className="split-total">Parent total <strong>{formatMoney(transaction.amount_minor, transaction.currency)}</strong></p><label>First amount<input aria-label="First split amount" type="number" step={currencyStep(transaction.currency)} value={minorToMajorInput(firstMinor, transaction.currency)} onChange={(event) => setFirstMinor(majorInputToMinor(event.target.value, transaction.currency))} /></label><label>First category<select value={firstCategory} onChange={(event) => setFirstCategory(event.target.value)}><option value="">Uncategorized</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Remaining amount<input aria-label="Remaining split amount" readOnly value={minorToMajorInput(secondMinor, transaction.currency)} /></label><label>Remaining category<select value={secondCategory} onChange={(event) => setSecondCategory(event.target.value)}><option value="">Uncategorized</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button>Save exact split</button></div></form></section></div>;
}

function CashFlowDiagram({ report, onSelect, splitByOwner = false }: { report: FlowReport; onSelect: (selection: FlowSelection) => void; splitByOwner?: boolean }) {
  const links = splitByOwner ? splitLinksByOwner(report) : report.links;
  const shares = expenseNodeShares(report);
  const data = {
    nodes: report.nodes.map((node, index) => ({
      ...node,
      name: node.label,
      totalBasisPoints: shares[index]?.totalBasisPoints,
      ownerBasisPoints: splitByOwner ? shares[index]?.ownerBasisPoints : undefined,
    })),
    links: links.map((link) => ({ ...link, value: link.amount_minor })),
  };
  return <div className="flow-chart" style={{ height: flowChartHeight(report.nodes.length) }}><ResponsiveContainer width="100%" height="100%"><Sankey data={data} iterations={0} sort={false} verticalAlign="top" nodePadding={FLOW_NODE_PADDING} nodeWidth={9} linkCurvature={0.42} margin={{ top: 24, right: 265, bottom: 24, left: 155 }} node={(props) => <FlowNodeShape {...props} selectFlow={onSelect} />} link={(props) => <FlowLinkShape {...props} selectFlow={onSelect} />} /></ResponsiveContainer></div>;
}

function FlowNodeShape({ payload, x, y, width, height, selectFlow }: SankeyNodeProps & { selectFlow: (selection: FlowSelection) => void }) {
  const node = payload as typeof payload & FlowNode;
  const labelOnLeft = node.kind !== "expense" && payload.depth >= 2;
  const labelX = labelOnLeft ? x - 7 : x + width + 7;
  const ownerText = node.ownerBasisPoints
    ? (["David", "Ariela", "Shared"] as SpendingOwner[]).filter((owner) => node.ownerBasisPoints?.[owner] !== undefined).map((owner) => `${owner} ${formatBasisPoints(node.ownerBasisPoints?.[owner] || 0)}`).join(" · ")
    : "";
  const activate = () => selectFlow({ label: node.label, entry_ids: node.entry_ids, node_id: node.id });
  return <g className="flow-node">
    <rect x={x} y={y} width={Math.max(width, 12)} height={Math.max(height, 8)} fill={flowColor(node.kind)} rx={2} role="button" tabIndex={0} aria-label={`Show ${node.label} transactions`} onClick={activate} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }} />
    <text x={labelX} y={y + Math.max(height, 12) / 2 - (ownerText ? 9 : 2)} textAnchor={labelOnLeft ? "end" : "start"}><tspan>{node.label}</tspan><tspan x={labelX} dy="1.2em" className="flow-value">{formatMoney(node.amount_minor)}{node.totalBasisPoints !== undefined ? ` · ${formatBasisPoints(node.totalBasisPoints)} of spending` : ""}</tspan>{ownerText && <tspan x={labelX} dy="1.2em" className="flow-owner-value">{ownerText}</tspan>}</text>
  </g>;
}

function FlowLinkShape({ sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, payload, selectFlow }: SankeyLinkProps & { selectFlow: (selection: FlowSelection) => void }) {
  const link = payload as typeof payload & FlowLink & { source: typeof payload.source & FlowNode; target: typeof payload.target & FlowNode };
  const pathLabel = `${link.source.label} to ${link.target.label}`;
  const label = link.owner ? `${link.owner} · ${pathLabel}` : pathLabel;
  const activate = () => selectFlow({ label, entry_ids: link.entry_ids, source_id: link.source.id, target_id: link.target.id, owner: link.owner });
  const visibleWidth = link.owner ? Math.max(linkWidth - 0.8, 0.8) : Math.max(linkWidth, 2);
  return <path d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`} fill="none" stroke={link.owner ? ownerColor(link.owner) : flowColor(link.target.kind)} strokeOpacity={link.owner ? 0.62 : 0.28} strokeWidth={visibleWidth} role="button" tabIndex={0} aria-label={`Show ${label} transactions`} onClick={activate} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }} className="flow-link" />;
}

function FlowDrawer({ selection, entries, categories, scope, feedback, undoAvailable, onScopeChange, onCategorize, onUndo, onClose }: { selection: FlowSelection; entries: FlowEntry[]; categories: Category[]; scope: CategorizationScope; feedback?: { tone: "status" | "error"; text: string }; undoAvailable: boolean; onScopeChange: (scope: CategorizationScope) => void; onCategorize: (entry: FlowEntry, categoryId: string) => Promise<boolean>; onUndo: () => Promise<void>; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [editingTransactionId, setEditingTransactionId] = useState<string>();
  const [pendingTransactionId, setPendingTransactionId] = useState<string>();
  const selectedIds = new Set(selection.entry_ids);
  const selected = entries.filter((entry) => selectedIds.has(entry.id)).sort((left, right) => right.local_date.localeCompare(left.local_date));
  useEffect(() => {
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  async function categorize(entry: FlowEntry, categoryId: string) {
    if (!categoryId || categoryId === entry.category_id) return;
    setPendingTransactionId(entry.transaction_id);
    const saved = await onCategorize(entry, categoryId);
    setPendingTransactionId(undefined);
    if (saved) setEditingTransactionId(undefined);
  }
  return <div className="flow-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="flow-drawer" role="dialog" aria-modal="true" aria-label={`${selection.label} transactions`}><div className="section-heading"><div><h2>{selection.label}</h2><small>{selected.length} contributing transaction{selected.length === 1 ? "" : "s"}</small></div><button ref={closeButton} className="quiet-button" aria-label="Close flow details" onClick={onClose}>Close</button></div><div className="flow-entries editable-drawer-entries">{(selected.length > 0 || feedback) && <div className="drawer-category-tools"><span>Apply category changes</span><CategorizationScopeControl value={scope} onChange={onScopeChange} disabled={Boolean(pendingTransactionId)} /></div>}{feedback && <p className={`drawer-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}{undoAvailable && feedback.tone === "status" && <button type="button" className="text-button" onClick={onUndo}>Undo</button>}</p>}{selected.length ? selected.map((entry) => {
    const editing = editingTransactionId === entry.transaction_id;
    const pending = pendingTransactionId === entry.transaction_id;
    return <div className="drawer-transaction" key={entry.id}><span><strong>{entry.merchant}</strong><small>{entry.local_date} · {entry.category}{entry.notes ? ` · ${entry.notes}` : ""}{entry.is_cash_withdrawal ? " · withdrawal changes apply once" : ""}</small>{editing ? <span className="drawer-category-editor"><select aria-label={`Category for ${entry.merchant}`} value={entry.category_id || ""} disabled={pending} onChange={(event) => categorize(entry, event.target.value)}><option value="" disabled>Uncategorized</option>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select><button type="button" className="text-button" disabled={pending} onClick={() => setEditingTransactionId(undefined)}>Cancel</button></span> : <button type="button" className="text-button" aria-label={`Edit category for ${entry.merchant}`} disabled={Boolean(pendingTransactionId && pendingTransactionId === entry.transaction_id)} onClick={() => setEditingTransactionId(entry.transaction_id)}>Edit</button>}</span><b className={entry.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(entry.amount_minor, entry.currency)}</b></div>;
  }) : <Empty title={feedback ? "No transactions remain in this path" : "No direct transactions"} text={feedback ? "Undo the category change above or close this detail view." : "This balancing path represents cash carried into the month rather than a transaction."} />}</div></aside></div>;
}

function flowColor(kind: string): string {
  if (kind === "expense" || kind === "expense_group" || kind === "adjustment") return "var(--red)";
  if (kind === "retained" || kind === "funding") return "var(--amber)";
  return "var(--teal)";
}

function ownerColor(owner: SpendingOwner): string {
  return `var(--${owner.toLowerCase()})`;
}

function formatBasisPoints(points: number): string {
  return `${(points / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function describeRule(source: string): string {
  try {
    const conditions = JSON.parse(source) as Record<string, string | number | boolean>;
    return Object.entries(conditions).map(([key, value]) => `${key.replaceAll("_", " ")} “${String(value)}”`).join(" and ");
  } catch { return "Invalid stored condition"; }
}

function categorySource(transaction: Transaction): string {
  if (!transaction.category_id) return "Needs category";
  if (transaction.category_source === "manual") return "Your choice";
  if (transaction.category_source === "rule") return "Learned rule";
  const confidence = transaction.provider_category_confidence?.replaceAll("_", " ").toLowerCase();
  return confidence ? `Plaid · ${confidence}` : "Plaid suggestion";
}

type DataResult<T> = { data?: T; loading: boolean; error?: string };
function DataBoundary<T>({ result, children }: { result: DataResult<T>; children: (data: T) => React.ReactNode }) { if (result.loading) return <PageState text="Reading the ledger…"/>; if (result.error) return <PageState error text={result.error}/>; return <>{children(result.data as T)}</>; }
function useData<T>(path: string, refresh = 0): DataResult<T> {
  const [result, setResult] = useState<DataResult<T>>({ loading: true });
  useEffect(() => { let current = true; setResult({ loading: true }); api<T>(path).then((data) => current && setResult({ data, loading: false })).catch((error: Error) => current && setResult({ loading: false, error: error.message })); return () => { current = false; }; }, [path, refresh]);
  return result;
}

function useTransactionPages(query: string, category: string, subcategory: string, owner: string, account: string, includeTransfers: boolean, includeArchived: boolean, refresh: string): DataResult<{ items: Transaction[]; next_cursor?: string }> & { loadingMore: boolean; loadMore: () => Promise<void>; cancelPending: () => void } {
  type PageResult = DataResult<{ items: Transaction[]; next_cursor?: string }> & { generation: number };
  const [result, setResult] = useState<PageResult>({ loading: true, generation: 0 });
  const [loadingMore, setLoadingMore] = useState(false);
  const basePath = `/transactions?limit=100${query ? `&search=${encodeURIComponent(query)}` : ""}${category ? `&category_id=${encodeURIComponent(category)}` : ""}${subcategory ? `&subcategory_id=${encodeURIComponent(subcategory)}` : ""}${owner ? `&spending_owner=${encodeURIComponent(owner)}` : ""}${account ? `&account_id=${encodeURIComponent(account)}` : ""}${includeTransfers ? "&include_transfers=true" : ""}${includeArchived ? "&include_archived=true" : ""}`;
  const generation = useRef(0);
  const loadedPath = useRef<string | undefined>(undefined);
  const loadMoreController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    let current = true;
    const effectGeneration = ++generation.current;
    const pathChanged = loadedPath.current !== basePath;
    loadedPath.current = basePath;
    loadMoreController.current?.abort();
    setLoadingMore(false);
    setResult((previous) => !pathChanged && previous.data
      ? { ...previous, error: undefined, generation: effectGeneration }
      : { loading: true, generation: effectGeneration });
    api<{ items: Transaction[]; next_cursor?: string }>(basePath)
      .then((data) => current && setResult((previous) => previous.generation === effectGeneration ? { data, loading: false, generation: effectGeneration } : previous))
      .catch((error: Error) => current && setResult((previous) => previous.generation === effectGeneration ? { loading: false, error: error.message, generation: effectGeneration } : previous));
    return () => { current = false; };
  }, [basePath, refresh]);
  async function loadMore() {
    const cursor = result.data?.next_cursor;
    if (!cursor || loadingMore) return;
    const pageGeneration = result.generation;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    try {
      const page = await api<{ items: Transaction[]; next_cursor?: string }>(`${basePath}&cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setResult((previous) => previous.generation === pageGeneration ? {
          loading: false,
          generation: pageGeneration,
          data: {
            items: [...(previous.data?.items || []), ...page.items],
            next_cursor: page.next_cursor,
          },
        } : previous);
    } catch (caught) {
      if (!controller.signal.aborted) setResult((previous) => previous.generation === pageGeneration ? { ...previous, error: caught instanceof Error ? caught.message : "Unable to load older transactions" } : previous);
    } finally {
      if (!controller.signal.aborted && generation.current === pageGeneration) setLoadingMore(false);
    }
  }
  function cancelPending() {
    loadMoreController.current?.abort();
    const nextGeneration = ++generation.current;
    setLoadingMore(false);
    setResult({ loading: true, generation: nextGeneration });
  }
  return { ...result, loadingMore, loadMore, cancelPending };
}
