import { describe, expect, it } from "vitest";

import { buildSavingsArcs, ownerColor, type SavingsGoal } from "../src/savings/model";

const goal = (id: string, target: number, funded: number): SavingsGoal => ({
  goal_id: id, name: id, pool: "regular", owner: "Shared", parent_id: null, linked_category_id: null,
  icon_key: "piggy_bank", color_key: "blue", priority: 1, locked: false,
  active: true, monthly_target_minor: target, balance_minor: funded,
  monthly_saved_minor: funded, monthly_funded_basis_points: target ? Math.min(10_000, funded * 10_000 / target) : null,
  overall_target_minor: null, overall_funded_basis_points: null, overall_remaining_minor: null, overflow_goal_ids: [],
  expected_to_date_minor: target, funded_basis_points: target ? Math.min(10_000, funded * 10_000 / target) : null,
  ahead_minor: Math.max(funded - target, 0), months: [], updated_at: "now",
});

describe("savings goal model", () => {
  it("builds exact allocation arcs and caps funded progress", () => {
    const arcs = buildSavingsArcs([goal("a", 20, 12), goal("b", 30, 45), goal("zero", 0, 10)]);
    expect(arcs.map((arc) => [arc.goal.goal_id, arc.allocationBasisPoints, arc.fundedBasisPoints])).toEqual([
      ["a", 4_000, 6_000], ["b", 6_000, 10_000],
    ]);
    expect(arcs.reduce((sum, arc) => sum + arc.allocationBasisPoints, 0)).toBe(10_000);
  });

  it("uses household owner colors and rejects malformed chart values", () => {
    expect(ownerColor("David")).toBe("blue");
    expect(ownerColor("Ariela")).toBe("pink");
    expect(ownerColor("Shared")).toBe("dark-purple");
    expect(buildSavingsArcs([goal("bad", Number.NaN, Number.POSITIVE_INFINITY)])).toEqual([]);
  });

  it("keeps monthly and overall donut progress separate", () => {
    const emergency = { ...goal("emergency", 100_000, 2_100_000), monthly_saved_minor: 100_000,
      monthly_funded_basis_points: 10_000, overall_target_minor: 2_500_000,
      overall_funded_basis_points: 8_400, overall_remaining_minor: 400_000 };
    expect(buildSavingsArcs([emergency], "monthly")[0].fundedBasisPoints).toBe(10_000);
    expect(buildSavingsArcs([emergency], "overall")[0].fundedBasisPoints).toBe(8_400);
  });
});
