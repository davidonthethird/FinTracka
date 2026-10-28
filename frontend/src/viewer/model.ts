export type SpendingOwner = "David" | "Ariela" | "Shared";

export interface RemoteTransaction {
  id: string;
  local_date: string;
  amount_minor: number;
  currency: string;
  description: string;
  merchant: string | null;
  category_id: string | null;
  category: string | null;
  subcategory_id: string | null;
  subcategory: string | null;
  spending_owner: SpendingOwner | null;
  account_name: string;
  account_type: string;
  account_subtype: string | null;
  account_mask: string | null;
  institution_name: string | null;
  pending: boolean;
  manual_cash: boolean;
  is_cash_withdrawal: boolean;
  updated_at: string;
}

export interface RemoteOverview {
  cash_minor: number;
  card_liabilities_minor: number;
  net_position_minor: number;
  income_minor: number;
  spending_minor: number;
  cash_income_minor: number;
  cash_spending_minor: number;
  cash_transfer_minor: number;
  opening_cash_minor: number | null;
  off_bank_cash_spending_minor: number;
}

export interface RemoteSnapshot {
  schema_version: 1;
  snapshot_id: string;
  source_sequence: number;
  captured_at: string;
  source_last_sync_at: string | null;
  sources: { name: string; status: string; last_success_at: string | null; error_code: string | null }[];
  history_start: string;
  history_end: string;
  overview: Record<string, RemoteOverview>;
  transactions: RemoteTransaction[];
  planning: Record<string, Record<string, unknown>>;
  savings: Record<string, Record<string, unknown>>;
  reports: Record<string, Record<string, unknown>>;
  counts: { transactions: number; sources: number; aggregate_months: number; detailed_months: number };
}

export interface TransactionFilters {
  search?: string;
  account?: string;
  category?: string;
  owner?: string;
  month?: string;
}

export function parseSnapshot(value: unknown): RemoteSnapshot {
  if (!value || typeof value !== "object") throw new Error("The remote snapshot is invalid.");
  const candidate = value as Partial<RemoteSnapshot>;
  if (
    candidate.schema_version !== 1 ||
    typeof candidate.snapshot_id !== "string" ||
    !Number.isInteger(candidate.source_sequence) ||
    typeof candidate.captured_at !== "string" ||
    !Array.isArray(candidate.transactions) ||
    !candidate.overview || typeof candidate.overview !== "object" ||
    !candidate.planning || !candidate.savings || !candidate.reports
  ) {
    throw new Error("This FinTracka snapshot version is not supported.");
  }
  return candidate as RemoteSnapshot;
}

export function snapshotMonths(snapshot: RemoteSnapshot): string[] {
  return Object.keys(snapshot.overview).sort((left, right) => right.localeCompare(left));
}

export function filterTransactions(
  transactions: RemoteTransaction[], filters: TransactionFilters,
): RemoteTransaction[] {
  const search = filters.search?.trim().toLocaleLowerCase();
  return transactions.filter((transaction) => {
    const searchable = [
      transaction.merchant, transaction.description, transaction.category,
      transaction.subcategory, transaction.account_name,
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return (!search || searchable.includes(search))
      && (!filters.account || transaction.account_name === filters.account)
      && (!filters.category || transaction.category_id === filters.category)
      && (!filters.owner || transaction.spending_owner === filters.owner)
      && (!filters.month || transaction.local_date.startsWith(filters.month));
  });
}

export function paginateTransactions(
  transactions: RemoteTransaction[], page: number, requestedSize = 50,
): RemoteTransaction[] {
  const size = Math.max(1, Math.min(requestedSize, 50));
  const start = Math.max(0, page - 1) * size;
  return transactions.slice(start, start + size);
}

export function freshnessLabel(value: string | null, now = new Date()): string {
  if (!value) return "Not available";
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
