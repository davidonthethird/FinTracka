import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { buildFlowGroups } from "../src/viewer/ReportFlow";
import { MobileExpandableSankey } from "../src/viewer/MobileExpandableSankey";
import { reportFixture } from "./mobile-flow-layout.test";

describe("mobile expandable financial flow", () => {
  it("renders the complete compact flow and accessible view controls", () => {
    const report = reportFixture();
    const html = renderToStaticMarkup(<MobileExpandableSankey
      report={report}
      groups={buildFlowGroups(report)}
      onSelect={vi.fn()}
    />);

    expect(html).toContain("Income");
    expect(html).toContain("Essentials");
    expect(html).toContain("Lifestyle");
    expect(html).toContain("Money retained");
    expect(html).toContain("$60.00");
    expect(html).toContain("66.7%");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-scale="1.0"');
    expect(html).toContain("mobile-flow-viewport");
    [
      "Compact", "Detailed", "Expand all", "Collapse all",
      "Split spending by person", "Everyone", "David", "Ariela", "Shared",
      "Search financial flow", "Zoom in", "Zoom out", "Fit to screen",
      "Reset view", "Enter fullscreen",
    ].forEach((name) => expect(html).toContain(name));
  });

  it("does not expose mutating controls in the read-only viewer", () => {
    const report = reportFixture();
    const html = renderToStaticMarkup(<MobileExpandableSankey
      report={report}
      groups={buildFlowGroups(report)}
      onSelect={vi.fn()}
    />);

    expect(html).not.toMatch(/>\s*(Save|Edit|Delete|Archive|Publish)\s*</i);
  });
});
