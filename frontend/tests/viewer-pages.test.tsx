import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../tests/fixtures/remote_snapshot_v1.json";

import { PlanningPage } from "../src/viewer/PlanningPage";
import { buildFlowGroups, ReportFlow, type FlowGraph } from "../src/viewer/ReportFlow";
import { ReportsPage, selectedFlowTransactions, spendingPercentage } from "../src/viewer/ReportsPage";
import { SavingsPage } from "../src/viewer/SavingsPage";
import { parseSnapshot } from "../src/viewer/model";

const snapshot = parseSnapshot(fixture);

describe("read-only viewer finance pages", () => {
  it("shows planning targets, actuals, averages, remaining, owner, and category details", () => {
    const html = renderToStaticMarkup(<PlanningPage snapshot={snapshot} />);
    expect(html).toContain("Monthly target");
    expect(html).toContain("Spent so far");
    expect(html).toContain("Historical average");
    expect(html).toContain("Remaining");
    expect(html).toContain("Combined");
    expect(html).toContain("Groceries");
  });

  it("shows combined savings by default, split choices, goals, and activity", () => {
    const html = renderToStaticMarkup(<SavingsPage snapshot={snapshot} />);
    expect(html).toContain("Total savings");
    expect(html).toContain("Combined");
    expect(html).toContain("David");
    expect(html).toContain("Ariela");
    expect(html).toContain("Monthly activity");
    expect(html).toContain("AUTOMATIC SAVING");
  });

  it("shows report category totals, owner shares, flow, and drill-down controls", () => {
    const html = renderToStaticMarkup(<ReportsPage snapshot={snapshot} />);
    expect(html).toContain("Income");
    expect(html).toContain("Spending");
    expect(html).toContain("By category");
    expect(html).toContain("By person");
    expect(html).toContain("Money flow");
    expect(html).toContain("Groceries");
    expect(html).toContain("Zoomable financial flow");
    expect(html).toContain("Focus Essentials");
    expect(html).toContain("% of spending");
  });

  it("derives groups and final categories from published flow links and safely handles missing flow", () => {
    const report = snapshot.reports["2026-10|owner=Combined"] as { cash_flow_paths?: Parameters<typeof buildFlowGroups>[0] };
    const groups = buildFlowGroups(report.cash_flow_paths);
    expect(groups.map((group) => group.label)).toEqual(["Essentials", "Financial", "Lifestyle"]);
    expect(groups.flatMap((group) => group.categories.map((category) => category.label))).toEqual(["Groceries", "Other", "Shopping"]);
    expect(buildFlowGroups(undefined)).toEqual([]);
  });

  it("falls back for partial flow data and gives dense desktop flows enough height", () => {
    const categories = Array.from({ length: 18 }, (_, index) => ({ category_id: `c${index}`, category: `Category ${index}`, amount_minor: 100 }));
    const entries = categories.map((item, index) => ({ id: `e${index}`, transaction_id: `t${index}`, local_date: "2026-10-01", merchant: item.category, description: item.category, category: item.category, category_id: item.category_id, amount_minor: -100, currency: "USD", spending_owner: "Shared" }));
    const entryIds = entries.map((entry) => entry.id);
    const graph: FlowGraph = {
      nodes: [
        { id: "income", label: "Income", kind: "hub", amount_minor: 1800, entry_ids: entryIds },
        { id: "group:g", label: "Essentials", kind: "expense_group", amount_minor: 1800, entry_ids: entryIds },
        ...categories.map((item, index) => ({ id: `expense:${item.category_id}`, label: item.category, kind: "expense", amount_minor: item.amount_minor, entry_ids: [entries[index].id] })),
      ],
      links: [
        { source: 0, target: 1, amount_minor: 1800, entry_ids: entryIds },
        ...categories.map((item, index) => ({ source: 1, target: index + 2, amount_minor: item.amount_minor, entry_ids: [entries[index].id] })),
      ],
      entries,
    };
    expect(renderToStaticMarkup(<ReportFlow report={graph} expectedCategories={categories} onCategory={() => undefined} />)).toContain("height:960px");
    expect(buildFlowGroups(graph, [...categories, { category_id: "missing", category: "Missing", amount_minor: 1 }])).toEqual([]);
    expect(buildFlowGroups({ ...graph, entries: undefined }, categories)).toEqual([]);
  });

  it("uses positive final expenses for percentages when refunds reduce net spending", () => {
    expect(spendingPercentage(100, [
      { category_id: "a", category: "A", amount_minor: 100 },
      { category_id: "b", category: "B", amount_minor: 50 },
      { category_id: "c", category: "Refund", amount_minor: -50 },
    ])).toBe("66.7");
  });

  it("uses published ledger entries for exact split amounts in report drawers", () => {
    const base = snapshot.transactions.find((item) => item.category_id) ?? snapshot.transactions[0];
    const graph: FlowGraph = { nodes: [], links: [], entries: [{
      id: "split:1", transaction_id: base.id, local_date: base.local_date, merchant: base.merchant,
      description: base.description, category: "Groceries", category_id: "groceries", amount_minor: -1234,
      currency: "USD", spending_owner: "Shared",
    }] };
    const rows = selectedFlowTransactions({ category_id: "groceries", category: "Groceries", amount_minor: 1234, entryIds: ["split:1"] }, graph, [base]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "split:1", amount_minor: -1234, account_name: base.account_name });
  });

  it("contains no mutation controls and makes no request while rendering", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const html = [PlanningPage, SavingsPage, ReportsPage]
      .map((Page) => renderToStaticMarkup(<Page snapshot={snapshot} />))
      .join(" ");
    expect(html).not.toMatch(/Save|Edit|Delete|Archive|Sync now|Add asset|Set target/);
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
