import { describe, expect, it } from "vitest";

import { flowScale, minimumTarget, planningPath, remainingLabel, type PlanningCategory } from "./model";

const row: PlanningCategory = {
  category_id: "shopping",
  category: "Shopping",
  historical_average_minor: 50_000,
  target_minor: 40_000,
  actual_minor: 45_000,
  remaining_minor: -5_000,
  status: "overspent",
  trend: [],
  transaction_ids: [],
  tzedaka_minimum_minor: 0,
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

  it("never displays a target below the Tzedaka minimum", () => {
    expect(minimumTarget({ ...row, tzedaka_minimum_minor: 59_001 }, 50_000)).toBe(59_001);
    expect(minimumTarget({ ...row, tzedaka_minimum_minor: 59_001 }, 70_000)).toBe(70_000);
  });
});
