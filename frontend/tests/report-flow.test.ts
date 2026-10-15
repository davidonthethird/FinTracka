import { describe, expect, it } from "vitest";

import { expenseNodeShares, FLOW_NODE_PADDING, flowChartHeight, splitLinksByOwner } from "../src/reports/flow";

describe("person-colored report flow", () => {
  it("reserves enough vertical space to keep category blocks readable", () => {
    expect(FLOW_NODE_PADDING).toBeGreaterThanOrEqual(28);
    expect(flowChartHeight(18)).toBeGreaterThanOrEqual(850);
  });

  it("splits expense ribbons by owner while retaining exact totals", () => {
    const report = {
      nodes: [
        { kind: "hub" },
        { kind: "expense_group" },
        { kind: "expense" },
      ],
      links: [
        { source: 0, target: 1, amount_minor: 1_000, entry_ids: ["d", "a", "s"] },
        { source: 1, target: 2, amount_minor: 1_000, entry_ids: ["d", "a", "s"] },
      ],
      entries: [
        { id: "d", amount_minor: -500, spending_owner: "David" },
        { id: "a", amount_minor: -300, spending_owner: "Ariela" },
        { id: "s", amount_minor: -200, spending_owner: "Shared" },
      ],
    };

    const links = splitLinksByOwner(report);

    expect(links).toHaveLength(6);
    expect(links.slice(0, 3).map((link) => [link.owner, link.amount_minor])).toEqual([
      ["David", 500], ["Ariela", 300], ["Shared", 200],
    ]);
    expect(links.slice(0, 3).reduce((sum, link) => sum + link.amount_minor, 0)).toBe(1_000);
  });

  it("does not split income ribbons", () => {
    const report = {
      nodes: [{ kind: "income" }, { kind: "hub" }],
      links: [{ source: 0, target: 1, amount_minor: 500, entry_ids: ["income"] }],
      entries: [{ id: "income", amount_minor: 500, spending_owner: null }],
    };

    expect(splitLinksByOwner(report)).toEqual(report.links);
  });

  it("calculates endpoint shares of total and of each category", () => {
    const report = {
      nodes: [
        { kind: "expense_group", amount_minor: 1_000, entry_ids: ["d", "a", "s", "other"] },
        { kind: "expense", amount_minor: 600, entry_ids: ["d", "a", "s"] },
        { kind: "expense", amount_minor: 400, entry_ids: ["other"] },
      ],
      links: [],
      entries: [
        { id: "d", amount_minor: -300, spending_owner: "David" },
        { id: "a", amount_minor: -200, spending_owner: "Ariela" },
        { id: "s", amount_minor: -100, spending_owner: "Shared" },
        { id: "other", amount_minor: -400, spending_owner: "Shared" },
      ],
    };

    expect(expenseNodeShares(report)).toEqual({
      1: { totalBasisPoints: 6_000, ownerBasisPoints: { David: 5_000, Ariela: 3_333, Shared: 1_667 } },
      2: { totalBasisPoints: 4_000, ownerBasisPoints: { Shared: 10_000 } },
    });
  });
});
