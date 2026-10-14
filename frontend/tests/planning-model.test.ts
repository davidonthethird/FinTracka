import { describe, expect, it } from "vitest";

import {
  coverageLabel,
  flowScale,
  laneWeight,
  minimumTarget,
  overallStatusLabel,
  percentLabel,
  planningPath,
  remainingLabel,
  type PlanningCategory,
  type PlanningSnapshot,
} from "../src/planning/model";

const row: PlanningCategory = {
  category_id: "shopping",
  category: "Shopping",
  historical_average_minor: 50_000,
  target_minor: 40_000,
  actual_minor: 45_000,
  remaining_minor: -5_000,
  status: "overspent",
  percent_used_basis_points: 11_250,
  percent_remaining_basis_points: -1_250,
  projected_minor: 48_000,
  subcategories: [],
  trend: [],
  transaction_ids: [],
  tzedaka_minimum_minor: 0,
  updated_at: "2026-10-13T00:00:00Z",
};

describe("planning view model", () => {
  it("builds stable window and owner queries", () => {
    expect(planningPath("2026-10", 9, "David")).toBe("/planning/2026-10?average_months=9&spending_owner=David");
    expect(planningPath("2026-10", 12)).toBe("/planning/2026-10?average_months=12");
    expect(() => planningPath("2026-10", 0)).toThrow();
    expect(() => planningPath("2026-10", 13)).toThrow();
  });

  it("derives status text and bounded flow widths", () => {
    expect(remainingLabel(row)).toBe("5000 over");
    expect(flowScale(row)).toEqual({ average: 1, target: 0.8, actual: 0.9 });
    expect(flowScale({ ...row, historical_average_minor: 0, target_minor: 0, actual_minor: 0 })).toEqual({ average: 0, target: 0, actual: 0 });
  });

  it("labels unplanned spending, coverage, percentages, and projected outcomes", () => {
    expect(percentLabel(row)).toBe("12.5% over");
    expect(percentLabel({
      ...row, target_minor: 0, actual_minor: 5_000, remaining_minor: -5_000,
      status: "unplanned", percent_used_basis_points: null, percent_remaining_basis_points: null,
    })).toBe("Unplanned spending");
    const snapshot = {
      average_months: 12,
      usable_average_months: 2,
      projected_surplus_shortfall_minor: -2_500,
      status: "projected_over",
    } as PlanningSnapshot;
    expect(coverageLabel(snapshot)).toBe("2 of 12 months available");
    expect(overallStatusLabel(snapshot)).toBe("Projected $25.00 over plan");
  });

  it("allocates category lanes by target with a readable minimum", () => {
    const categories = [row, { ...row, category_id: "housing", target_minor: 60_000 }];
    expect(laneWeight(row, categories)).toBe(0.4);
    expect(laneWeight({ ...row, target_minor: 0, historical_average_minor: 100 }, [row])).toBe(0.08);
  });

  it("never displays a target below the Tzedaka minimum", () => {
    expect(minimumTarget({ ...row, tzedaka_minimum_minor: 59_001 }, 50_000)).toBe(59_001);
    expect(minimumTarget({ ...row, tzedaka_minimum_minor: 59_001 }, 70_000)).toBe(70_000);
  });
});
