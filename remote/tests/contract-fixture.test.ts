import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseRemoteSnapshot } from "../src/contract";

const fixture = JSON.parse(
  readFileSync("../tests/fixtures/remote_snapshot_v1.json", "utf8"),
);

describe("remote snapshot contract", () => {
  it("accepts the shared Python fixture", () => {
    expect(parseRemoteSnapshot(fixture).schema_version).toBe(1);
  });

  it("accepts new flow subcategories while remaining compatible with old v1 entries", () => {
    const reportKey = Object.keys(fixture.reports).find((key) => fixture.reports[key].cash_flow_paths?.entries?.length);
    const report = fixture.reports[reportKey!];
    const [entry, ...remaining] = report.cash_flow_paths.entries;
    const withEntry = (value: Record<string, unknown>) => ({
      ...fixture,
      reports: {
        ...fixture.reports,
        [reportKey!]: {
          ...report,
          cash_flow_paths: { ...report.cash_flow_paths, entries: [value, ...remaining] },
        },
      },
    });

    expect(parseRemoteSnapshot(withEntry({
      ...entry, subcategory_id: "subcategory-1", subcategory: "Fuel",
    })).schema_version).toBe(1);
    expect(parseRemoteSnapshot(withEntry(entry)).schema_version).toBe(1);
    expect(() => parseRemoteSnapshot(withEntry({
      ...entry, subcategory_id: 42, subcategory: "Fuel",
    }))).toThrow();
  });

  it.each([
    [{ ...fixture, schema_version: 2 }],
    [{ ...fixture, unexpected: true }],
    [{ ...fixture, captured_at: "not-a-date" }],
    [{ ...fixture, transactions: [{ ...fixture.transactions[0], currency: "usd" }] }],
    [{ ...fixture, transactions: [{ ...fixture.transactions[0], amount_minor: 1.5 }] }],
    [{ ...fixture, planning: { bad: { notes: "private" } } }],
    [{ ...fixture, planning: Object.fromEntries(Object.entries(fixture.planning).map(([key, value]: [string, any], index) => [key, index ? value : { ...value, unexpected: true }])) }],
  ])("rejects unsupported, extra, malformed, floating, or forbidden data", (value) => {
    expect(() => parseRemoteSnapshot(value)).toThrow();
  });
});
