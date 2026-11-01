import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import fixture from "../../tests/fixtures/remote_snapshot_v1.json";

import { navigationPathForRoute, viewerNavigation } from "../src/viewer/ViewerApp";
import { MobileCommandProvider } from "../src/viewer/mobileCommands";
import { parseSnapshot } from "../src/viewer/model";
import { TransactionsPage } from "../src/viewer/TransactionsPage";

const snapshot = parseSnapshot(fixture);

describe("viewer navigation", () => {
  it("keeps exactly five persistent destinations and treats receipts as transaction work", () => {
    expect(viewerNavigation.map((item) => item[1])).toEqual([
      "Overview", "Transactions", "Planning", "Savings", "Reports",
    ]);
    expect(navigationPathForRoute("/receipts")).toBe("/transactions");
    expect(navigationPathForRoute("/receipts/new")).toBe("/transactions");
    expect(navigationPathForRoute("/receipts/draft-1")).toBe("/transactions");
    expect(navigationPathForRoute("/receipts-archive")).toBe("/receipts-archive");
    expect(navigationPathForRoute("/reports")).toBe("/reports");
  });

  it("opens the receipt inbox from a prominent Transactions action", () => {
    const html = renderToStaticMarkup(
      <MobileCommandProvider snapshot={snapshot} onSnapshotRefresh={async () => undefined}>
        <TransactionsPage snapshot={snapshot} navigate={() => undefined} />
      </MobileCommandProvider>,
    );
    expect(html).toContain("Scan receipt");
    expect(html).toContain("Review and split purchases");
  });

  it("keeps the mobile bar to one five-column safe-area row", () => {
    const css = readFileSync(new URL("../src/viewer/viewer.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.viewer-nav\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*1fr\)/s);
    expect(css).toMatch(/\.viewer-nav button\s*\{[^}]*min-height:\s*44px/s);
  });
});
