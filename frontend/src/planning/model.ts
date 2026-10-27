export type SpendingOwner = "David" | "Ariela" | "Shared";

export type PlanningTrendPoint = { month: string; amount_minor: number };
export type PlanningSubcategory = {
  subcategory_id: string | null;
  subcategory: string;
  actual_minor: number;
};
export type PlanningIncome = {
  source_id: string;
  title: string;
  income_type: "Salary" | "Custom";
  amount_minor: number;
  updated_at: string;
};
export type PlanningCategory = {
  category_id: string;
  category: string;
  historical_average_minor: number;
  target_minor: number;
  actual_minor: number;
  remaining_minor: number;
  status: "no_target" | "unplanned" | "refund" | "on_track" | "close" | "projected_over" | "overspent";
  percent_used_basis_points: number | null;
  percent_remaining_basis_points: number | null;
  projected_minor: number | null;
  subcategories: PlanningSubcategory[];
  trend: PlanningTrendPoint[];
  transaction_ids: string[];
  tzedaka_minimum_minor: number;
  updated_at: string;
};
export type PlanningSnapshot = {
  month: string;
  average_months: number;
  spending_owner: SpendingOwner | null;
  incomes: PlanningIncome[];
  planned_income_total_minor: number;
  salary_total_minor: number;
  tzedaka_minimum_minor: number;
  target_total_minor: number;
  surplus_shortfall_minor: number;
  usable_average_months: number;
  earliest_usable_month: string | null;
  historical_months: string[];
  actual_total_minor: number;
  remaining_total_minor: number;
  percent_used_basis_points: number | null;
  percent_remaining_basis_points: number | null;
  projected_spending_minor: number | null;
  projected_surplus_shortfall_minor: number | null;
  status: "no_plan" | "unplanned" | "on_track" | "close" | "projected_over";
  elapsed_days: number | null;
  days_in_month: number | null;
  categories: PlanningCategory[];
};

export function planningPath(month: string, averageMonths: number, owner = ""): string {
  if (!Number.isInteger(averageMonths) || averageMonths < 1 || averageMonths > 12) {
    throw new Error("Average window must be between 1 and 12 months");
  }
  const params = new URLSearchParams({ average_months: String(averageMonths) });
  if (owner) params.set("spending_owner", owner);
  return `/planning/${month}?${params}`;
}

export function remainingLabel(category: PlanningCategory): string {
  if (!category.target_minor) return category.actual_minor > 0 ? "Unplanned spending" : "No target";
  if (category.remaining_minor < 0) return `${Math.abs(category.remaining_minor)} over`;
  return `${category.remaining_minor} left`;
}

export function percentLabel(category: PlanningCategory): string {
  if (category.status === "unplanned") return "Unplanned spending";
  const remaining = category.percent_remaining_basis_points;
  if (remaining === null) return category.status === "refund" ? "Refund activity" : "No percentage";
  return `${formatBasisPoints(Math.abs(remaining))}% ${remaining < 0 ? "over" : "left"}`;
}

export function coverageLabel(snapshot: Pick<PlanningSnapshot, "usable_average_months" | "average_months">): string {
  return `${snapshot.usable_average_months} of ${snapshot.average_months} months available`;
}

export function visiblePlanningCategories(categories: PlanningCategory[], showInactive: boolean): PlanningCategory[] {
  return showInactive ? categories : categories.filter((category) => category.target_minor !== 0 || category.actual_minor !== 0);
}

export function actualCategoryStatus(category: PlanningCategory): "no_target" | "unplanned" | "refund" | "on_track" | "overspent" {
  if (category.actual_minor < 0) return "refund";
  if (!category.target_minor) return category.actual_minor > 0 ? "unplanned" : "no_target";
  return category.remaining_minor < 0 ? "overspent" : "on_track";
}

export function laneWeight(category: PlanningCategory, categories: PlanningCategory[]): number {
  const values = categories.map((item) => Math.max(item.target_minor || item.historical_average_minor, 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const value = Math.max(category.target_minor || category.historical_average_minor, 0);
  return Math.max(total ? value / total : 0, 0.08);
}

function formatBasisPoints(value: number): string {
  return (value / 100).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

export function flowScale(category: PlanningCategory): { average: number; target: number; actual: number } {
  const largest = Math.max(
    category.historical_average_minor,
    category.target_minor,
    category.actual_minor,
    1,
  );
  return {
    average: category.historical_average_minor / largest,
    target: category.target_minor / largest,
    actual: category.actual_minor / largest,
  };
}

export function minimumTarget(category: PlanningCategory, inputMinor: number): number {
  return Math.max(inputMinor, category.tzedaka_minimum_minor);
}
