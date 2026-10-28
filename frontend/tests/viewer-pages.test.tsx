import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../tests/fixtures/remote_snapshot_v1.json";

import { PlanningPage } from "../src/viewer/PlanningPage";
import { buildFlowGroups } from "../src/viewer/ReportFlow";
import { ReportsPage } from "../src/viewer/ReportsPage";
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
