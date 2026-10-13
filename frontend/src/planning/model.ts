export type SpendingOwner = "David" | "Ariela" | "Shared";

export type PlanningTrendPoint = { month: string; amount_minor: number };
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
  status: "no_target" | "on_track" | "overspent";
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
  if (!category.target_minor) return "No target";
  if (category.remaining_minor < 0) return `${Math.abs(category.remaining_minor)} over`;
  return `${category.remaining_minor} left`;
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
