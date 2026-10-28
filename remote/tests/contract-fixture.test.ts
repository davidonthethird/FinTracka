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
