import { describe, expect, it } from "vitest";

import { currentMonth, currencyStep, formatMoney, majorInputToMinor, minorToMajorInput, movementWidths, totalsByCurrency } from "../src/format";

describe("financial formatting", () => {
  it("formats signed integer minor units without floating point arithmetic", () => {
    expect(formatMoney(123456, "USD")).toBe("$1,234.56");
    expect(formatMoney(-1, "USD")).toBe("-$0.01");
  });

  it("gives every cash movement a visible proportional width", () => {
    expect(movementWidths([0, 100, 300])).toEqual([4, 25, 75]);
  });

  it("uses each currency's minor-unit exponent", () => {
    expect(formatMoney(1000, "JPY")).toBe("¥1,000");
    expect(formatMoney(1000, "KWD")).toContain("1.000");
    expect(minorToMajorInput(1000, "JPY")).toBe("1000");
    expect(majorInputToMinor("600", "JPY")).toBe(600);
    expect(minorToMajorInput(1000, "KWD")).toBe("1.000");
    expect(majorInputToMinor("1.250", "KWD")).toBe(1250);
    expect(currencyStep("KWD")).toBe(0.001);
  });

  it("keeps account totals separate by currency", () => {
    expect(totalsByCurrency([
      { balance_minor: 100, currency: "USD" },
      { balance_minor: 200, currency: "EUR" },
      { balance_minor: 50, currency: "USD" },
    ])).toEqual([{ currency: "EUR", minor: 200 }, { currency: "USD", minor: 150 }]);
  });

  it("chooses the reporting month in New York rather than UTC", () => {
    expect(currentMonth(new Date("2026-11-01T03:30:00Z"))).toBe("2026-10");
  });
});
