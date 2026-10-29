import { describe, expect, it } from "vitest";

import { buildFlowGroups, type FlowGraph } from "../src/viewer/ReportFlow";
import {
  buildMobileFlowModel,
  layoutMobileFlow,
  MIN_VISIBLE_RIBBON_PX,
  type MobileFlowPosition,
} from "../src/viewer/mobileFlowLayout";

function reportFixture(): FlowGraph {
  return {
    nodes: [
      { id: "income", label: "Income", kind: "hub", amount_minor: 17_000, entry_ids: ["salary"] },
      { id: "income:salary", label: "Salary", kind: "income", amount_minor: 15_000, entry_ids: ["salary"] },
      { id: "funding-gap", label: "Prior cash", kind: "funding", amount_minor: 2_000, entry_ids: [] },
      { id: "group:essentials", label: "Essentials", kind: "expense_group", amount_minor: 6_000, entry_ids: ["g1", "g2", "g3", "u1"] },
      { id: "expense:groceries", label: "Groceries", kind: "expense", amount_minor: 4_000, entry_ids: ["g1", "g2", "g3"] },
      { id: "expense:utilities", label: "Utilities", kind: "expense", amount_minor: 2_000, entry_ids: ["u1"] },
      { id: "group:lifestyle", label: "Lifestyle", kind: "expense_group", amount_minor: 3_000, entry_ids: ["s1", "s2"] },
      { id: "expense:shopping", label: "Shopping", kind: "expense", amount_minor: 3_000, entry_ids: ["s1", "s2"] },
      { id: "retained", label: "Money retained", kind: "retained", amount_minor: 8_000, entry_ids: ["salary"] },
    ],
    links: [
      { source: 1, target: 0, amount_minor: 15_000, entry_ids: ["salary"] },
      { source: 2, target: 0, amount_minor: 2_000, entry_ids: [] },
      { source: 0, target: 3, amount_minor: 6_000, entry_ids: ["g1", "g2", "g3", "u1"] },
      { source: 3, target: 4, amount_minor: 4_000, entry_ids: ["g1", "g2", "g3"] },
      { source: 3, target: 5, amount_minor: 2_000, entry_ids: ["u1"] },
      { source: 0, target: 6, amount_minor: 3_000, entry_ids: ["s1", "s2"] },
      { source: 6, target: 7, amount_minor: 3_000, entry_ids: ["s1", "s2"] },
      { source: 0, target: 8, amount_minor: 8_000, entry_ids: ["salary"] },
    ],
    entries: [
      entry("salary", 15_000, "Salary", "salary", null, null, null),
      entry("g1", -3_000, "Groceries", "groceries", "food", "Food", "David"),
      entry("g2", 500, "Groceries", "groceries", "food", "Food", "David"),
      entry("g3", -1_500, "Groceries", "groceries", null, null, "Shared"),
      entry("u1", -2_000, "Utilities", "utilities", "electric", "Electric", "Ariela"),
      entry("s1", -1_000, "Shopping", "shopping", "clothes", "Clothes", "David"),
      entry("s2", -2_000, "Shopping", "shopping", "household", "Household", "Ariela"),
    ],
  } as FlowGraph;
}

function entry(
  id: string,
  amount: number,
  category: string,
  categoryId: string,
  subcategoryId: string | null,
  subcategory: string | null,
  owner: "David" | "Ariela" | "Shared" | null,
) {
  return {
    id, transaction_id: `t-${id}`, local_date: "2026-10-01", merchant: id,
    description: id, category, category_id: categoryId, subcategory_id: subcategoryId,
    subcategory, amount_minor: amount, currency: "USD", spending_owner: owner,
  };
}

describe("mobile financial flow model", () => {
  it("preserves sources, terminals, subcategories, refunds, and owner denominators", () => {
    const report = reportFixture();
    const groups = buildFlowGroups(report);
    const model = buildMobileFlowModel(report, groups, "Everyone");
    const david = buildMobileFlowModel(report, groups, "David");

    expect(model).not.toBeNull();
    expect(model!.sources.map((item) => item.label)).toEqual(["Salary", "Prior cash"]);
    expect(model!.terminals.map((item) => item.label)).toContain("Money retained");
    const groceries = model!.groups.flatMap((group) => group.children)
      .find((category) => category.label === "Groceries")!;
    expect(groceries.children.map((item) => [item.label, item.amountMinor])).toEqual([
      ["Food", 2_500],
      ["No subcategory", 1_500],
    ]);
    expect(groceries.children.reduce((sum, item) => sum + item.amountMinor, 0))
      .toBe(groceries.amountMinor);
    expect(david!.visibleSpendingMinor).toBe(3_500);
    const davidGroceries = david!.groups.flatMap((group) => group.children)
      .find((category) => category.label === "Groceries")!;
    expect(davidGroceries.percentBasisPoints).toBe(7_143);
  });

  it("rejects invalid links and missing ledger entries", () => {
    const report = reportFixture();
    expect(buildMobileFlowModel(
      { ...report, links: [{ ...report.links[0], target: 99 }] },
      buildFlowGroups(report),
      "Everyone",
    )).toBeNull();
    expect(buildMobileFlowModel(
      { ...report, entries: report.entries!.filter((item) => item.id !== "g1") },
      buildFlowGroups(report),
      "Everyone",
    )).toBeNull();
  });

  it.each([288, 343, 398])("lays out expanded branches without overlap at %ipx", (width) => {
    const report = reportFixture();
    const model = buildMobileFlowModel(report, buildFlowGroups(report), "Everyone")!;
    const collapsed = layoutMobileFlow(model, {
      width, expandedSource: false, expandedGroupIds: new Set(),
      expandedCategoryIds: new Set(), splitByOwner: false,
    });
    const expanded = layoutMobileFlow(model, {
      width,
      expandedSource: true,
      expandedGroupIds: new Set(model.groups.map((group) => group.id)),
      expandedCategoryIds: new Set(model.groups.flatMap((group) => group.children.map((item) => item.id))),
      splitByOwner: true,
    });

    expect(expanded.height).toBeGreaterThan(collapsed.height);
    expect(expanded.nodes.every((node) => node.x >= 0 && node.x + node.width <= expanded.width)).toBe(true);
    expect(overlappingNodePairs(expanded.nodes)).toEqual([]);
    expect(expanded.ribbons.every((ribbon) => ribbon.width >= MIN_VISIBLE_RIBBON_PX)).toBe(true);
  });

  it("emits one bounded node and ribbon set for every visible dense-flow item", () => {
    const report = denseReport(50);
    const model = buildMobileFlowModel(report, buildFlowGroups(report), "Everyone")!;
    const layout = layoutMobileFlow(model, {
      width: 343,
      expandedSource: true,
      expandedGroupIds: new Set(model.groups.map((group) => group.id)),
      expandedCategoryIds: new Set(model.groups.flatMap((group) => group.children.map((item) => item.id))),
      splitByOwner: false,
    });

    expect(layout.nodes).toHaveLength(103);
    expect(layout.ribbons).toHaveLength(102);
  });

  it("reconciles split-owner ribbon amounts to the visible household spending", () => {
    const report = reportFixture();
    const model = buildMobileFlowModel(report, buildFlowGroups(report), "Everyone")!;
    const layout = layoutMobileFlow(model, {
      width: 343, expandedSource: false, expandedGroupIds: new Set(),
      expandedCategoryIds: new Set(), splitByOwner: true,
    });

    expect(layout.ribbons.filter((ribbon) => ribbon.owner)
      .reduce((sum, ribbon) => sum + ribbon.amountMinor, 0)).toBe(model.visibleSpendingMinor);
  });
});

function overlappingNodePairs(nodes: MobileFlowPosition[]): string[] {
  const pairs: string[] = [];
  nodes.forEach((left, index) => nodes.slice(index + 1).forEach((right) => {
    if (left.x < right.x + right.width && left.x + left.width > right.x
      && left.y < right.y + right.height && left.y + left.height > right.y) {
      pairs.push(`${left.id}:${right.id}`);
    }
  }));
  return pairs;
}

function denseReport(count: number): FlowGraph {
  const entries = Array.from({ length: count }, (_, index) => entry(
    `dense-${index}`, -100, `Category ${index}`, `c${index}`, null, null, "Shared",
  ));
  const ids = entries.map((item) => item.id);
  return {
    nodes: [
      { id: "income", label: "Income", kind: "hub", amount_minor: count * 100, entry_ids: ["salary"] },
      { id: "group:dense", label: "Dense", kind: "expense_group", amount_minor: count * 100, entry_ids: ids },
      { id: "income:salary", label: "Salary", kind: "income", amount_minor: count * 100, entry_ids: ["salary"] },
      ...entries.map((item, index) => ({
        id: `expense:c${index}`, label: `Category ${index}`, kind: "expense",
        amount_minor: 100, entry_ids: [item.id],
      })),
    ],
    links: [
      { source: 2, target: 0, amount_minor: count * 100, entry_ids: ["salary"] },
      { source: 0, target: 1, amount_minor: count * 100, entry_ids: ids },
      ...entries.map((item, index) => ({ source: 1, target: index + 3, amount_minor: 100, entry_ids: [item.id] })),
    ],
    entries: [entry("salary", count * 100, "Salary", "salary", null, null, null), ...entries],
  } as FlowGraph;
}

export { reportFixture };
