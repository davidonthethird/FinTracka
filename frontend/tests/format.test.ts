import { describe, expect, it } from "vitest";

import { formatMoney, movementWidths } from "../src/format";

describe("financial formatting", () => {
  it("formats signed integer minor units without floating point arithmetic", () => {
    expect(formatMoney(123456, "USD")).toBe("$1,234.56");
    expect(formatMoney(-1, "USD")).toBe("-$0.01");
  });

  it("gives every cash movement a visible proportional width", () => {
    expect(movementWidths([0, 100, 300])).toEqual([4, 25, 75]);
  });
});
