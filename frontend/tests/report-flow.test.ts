import { describe, expect, it } from "vitest";

import { splitLinksByOwner } from "../src/reports/flow";

describe("person-colored report flow", () => {
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
});
