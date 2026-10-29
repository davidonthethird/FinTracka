import { describe, expect, it } from "vitest";

import { buildFlowGroups, type FlowGraph } from "../src/viewer/ReportFlow";
import {
  buildMobileFlowModel,
  layoutMobileFlow,
  MIN_VISIBLE_RIBBON_PX,
  MAX_VISIBLE_RIBBON_PX,
  type MobileFlowPosition,
} from "../src/viewer/mobileFlowLayout";
import { reportFixture } from "./mobile-flow-fixture";

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

  it("does not invent subcategories when legacy entries omit the new fields", () => {
    const report = reportFixture();
    const legacy = {
      ...report,
      entries: report.entries!.map(({ subcategory_id: _id, subcategory: _name, ...entry }) => entry),
    };
    const model = buildMobileFlowModel(legacy, buildFlowGroups(legacy), "Everyone")!;

    expect(model.groups.flatMap((group) => group.children)
      .find((category) => category.label === "Groceries")?.children).toEqual([]);
  });

  it("keeps the structural group and category flow when entry detail is unavailable", () => {
    const report = { ...reportFixture(), entries: undefined };
    const groups = buildFlowGroups(report);
    const model = buildMobileFlowModel(report, groups, "Everyone");

    expect(groups.flatMap((group) => group.categories).map((category) => category.label))
      .toEqual(["Groceries", "Utilities", "Shopping"]);
    expect(model?.groups.flatMap((group) => group.children).map((category) => category.label))
      .toEqual(["Groceries", "Utilities", "Shopping"]);
    expect(model?.groups.every((group) => group.children.every((category) => !category.children.length))).toBe(true);
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
    expect(expanded.ribbons.every((ribbon) => ribbon.width <= MAX_VISIBLE_RIBBON_PX)).toBe(true);
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
