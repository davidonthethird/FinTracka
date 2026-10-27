export type SavingsOwner = "David" | "Ariela" | "Shared";
export type BalancePoint = { observed_at: string; current_minor: number };
export type SavingsAccount = {
  account_id: string;
  name: string;
  owner: SavingsOwner;
  balance_minor: number;
  currency: string;
  pool: "regular" | "retirement" | null;
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
  savings_pool: "regular" | "retirement" | null;
  savings_goal_id: string | null;
};
export type SavingsMonthPoint = {
  month: string; opening_minor: number; additions_minor: number;
  spending_draw_minor: number; withdrawals_minor: number; earnings_minor: number;
  valuation_minor: number; adjustments_minor: number; closing_minor: number;
};
export type SavingsGoal = {
  goal_id: string; name: string; pool: "regular" | "retirement";
  owner: SavingsOwner; parent_id: string | null; linked_category_id: string | null; icon_key: string; color_key: string;
  priority: number; locked: boolean; active: boolean; monthly_target_minor: number;
  balance_minor: number; expected_to_date_minor: number;
  funded_basis_points: number | null; ahead_minor: number;
  months: SavingsMonthPoint[]; updated_at: string;
};
export type SavingsGoalOverview = {
  activation_month: string; through_month: string; plan_updated_at: string; owner: SavingsOwner | null;
  regular_minor: number; retirement_minor: number; combined_minor: number;
  unallocated_minor: number; pending_transfer_minor: number;
  regular_reconciliation_minor: number; retirement_reconciliation_minor: number;
  goals: SavingsGoal[];
};
export type SavingsGoalDetail = Pick<SavingsGoal, "goal_id" | "name" | "pool" | "owner" | "balance_minor" | "monthly_target_minor" | "months">;
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
  goal_ledger: SavingsGoalOverview | null;
  review: Record<string, unknown> | null;
};

export type SavingsArc = { goal: SavingsGoal; allocationBasisPoints: number; fundedBasisPoints: number };

export function buildSavingsArcs(goals: SavingsGoal[]): SavingsArc[] {
  const eligible = goals.filter((goal) => Number.isFinite(goal.monthly_target_minor) && goal.monthly_target_minor > 0);
  const total = eligible.reduce((sum, goal) => sum + goal.monthly_target_minor, 0);
  if (!Number.isFinite(total) || total <= 0) return [];
  const bases = eligible.map((goal) => Math.floor(goal.monthly_target_minor * 10_000 / total));
  let remainder = 10_000 - bases.reduce((sum, value) => sum + value, 0);
  const order = eligible.map((goal, index) => ({ index, fraction: goal.monthly_target_minor * 10_000 % total }))
    .sort((a, b) => b.fraction - a.fraction || eligible[a.index].priority - eligible[b.index].priority || a.index - b.index);
  for (let index = 0; index < remainder; index += 1) bases[order[index].index] += 1;
  return eligible.map((goal, index) => ({
    goal,
    allocationBasisPoints: bases[index],
    fundedBasisPoints: Number.isFinite(goal.funded_basis_points)
      ? Math.max(0, Math.min(10_000, goal.funded_basis_points ?? 0)) : 0,
  }));
}

export function ownerColor(owner: SavingsOwner): "blue" | "pink" | "dark-purple" {
  return owner === "David" ? "blue" : owner === "Ariela" ? "pink" : "dark-purple";
}

export function savingsPath(month: string, owner: string): string {
  return `/savings/${month}${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`;
}

export function activityLabel(kind: SavingsActivity["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
