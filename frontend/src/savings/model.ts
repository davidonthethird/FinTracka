export type SavingsOwner = "David" | "Ariela" | "Shared";
export type BalancePoint = { observed_at: string; current_minor: number };
export type SavingsAccount = {
  account_id: string;
  name: string;
  owner: SavingsOwner;
  balance_minor: number;
  currency: string;
  history: BalancePoint[];
};
export type ManualAsset = {
  id: string;
  title: string;
  kind: "savings" | "investment" | "other";
  owner: SavingsOwner;
  current_value_minor: number;
  currency: string;
  as_of_date: string;
  updated_at: string;
};
export type SavingsActivity = {
  transaction_id: string;
  account_id: string;
  local_date: string;
  title: string;
  kind: "contribution" | "withdrawal" | "earnings" | "expense";
  amount_minor: number;
  owner: SavingsOwner;
};
export type SavingsSummary = {
  month: string;
  owner: SavingsOwner | null;
  connected_total_minor: number;
  manual_savings_minor: number;
  investments_minor: number;
  other_assets_minor: number;
  combined_total_minor: number;
  contributions_minor: number;
  withdrawals_minor: number;
  earnings_minor: number;
  accounts: SavingsAccount[];
  manual_assets: ManualAsset[];
  activity: SavingsActivity[];
};

export function savingsPath(month: string, owner: string): string {
  return `/savings/${month}${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`;
}

export function activityLabel(kind: SavingsActivity["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
