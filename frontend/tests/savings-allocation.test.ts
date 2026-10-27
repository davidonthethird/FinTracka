import { describe, expect, it } from "vitest";
import { redistributeTargets, type AllocationRow } from "../src/savings/allocation";

const rows: AllocationRow[] = [
  { goal_id: "a", monthly_target_minor: 50_000, locked: true, priority: 1 },
  { goal_id: "b", monthly_target_minor: 40_000, locked: true, priority: 2 },
  { goal_id: "c", monthly_target_minor: 10_000, locked: true, priority: 3 },
];

describe("savings target redistribution", () => {
  it("keeps cents exact and unlocks a changed locked goal plus one partner", () => {
    const changed = redistributeTargets(rows, "a", 4_500);
    expect(changed.reduce((sum, row) => sum + row.monthly_target_minor, 0)).toBe(100_000);
    expect(changed.map((row) => row.locked)).toEqual([false, true, false]);
    expect(changed.map((row) => row.monthly_target_minor)).toEqual([45_000, 40_000, 15_000]);
  });
  it("leaves zero totals stable", () => {
    const zero = rows.map((row) => ({ ...row, monthly_target_minor: 0 }));
    expect(redistributeTargets(zero, "a", 5_000)).toEqual(zero);
  });
});
