import { expect, test } from "@playwright/test";

const viewer = "http://127.0.0.1:18789";

test("remote viewer is read-only, responsive, drillable, and leaves no financial browser data", async ({ page }) => {
  const consoleText: string[] = [];
  page.on("console", (message) => consoleText.push(message.text()));
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(viewer);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Transactions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
    const edges = await page.locator(".transaction-entry > b").evaluateAll((amounts) => amounts.map((amount) => Math.round(amount.getBoundingClientRect().right)));
    expect(new Set(edges).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    await expect(page.locator(width < 1000 ? ".mobile-flow-map" : ".flow-sankey")).toBeVisible();
    await expect(page.locator(width < 1000 ? ".flow-sankey" : ".mobile-flow-map")).toBeHidden();
    if (width < 1000) {
      const flowEdges = await page.locator(".mobile-flow-map").evaluate((element) => {
        const flow = element.getBoundingClientRect();
        const workspace = document.querySelector(".viewer-workspace")!.getBoundingClientRect();
        return {
          flowLeft: Math.round(flow.left), flowRight: Math.round(flow.right),
          workspaceLeft: Math.round(workspace.left), workspaceRight: Math.round(workspace.right),
        };
      });
      expect(flowEdges).toEqual({
        flowLeft: flowEdges.workspaceLeft, flowRight: flowEdges.workspaceRight,
        workspaceLeft: flowEdges.workspaceLeft, workspaceRight: flowEdges.workspaceRight,
      });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  for (const section of ["Transactions", "Planning", "Savings", "Reports"]) {
    await page.getByRole("button", { name: section, exact: true }).click();
    await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Transactions", exact: true }).click();
  const amountRightEdges = await page.locator(".transaction-entry > b").evaluateAll((amounts) =>
    amounts.map((amount) => Math.round(amount.getBoundingClientRect().right)),
  );
  expect(new Set(amountRightEdges).size).toBe(1);
  const ownerMarkerSize = await page.locator(".owner-dot").first().evaluate((marker) => {
    const box = marker.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  });
  expect(ownerMarkerSize).toEqual({ width: 7, height: 28 });
  await page.getByLabel("Search transactions").fill("LOWE");
  await expect(page.locator(".transaction-entry")).toHaveCount(1);
  await page.locator(".transaction-entry").click();
  await expect(page.getByRole("dialog")).toContainText("Account");
  await page.getByRole("button", { name: "Close transaction details" }).click();
  await page.getByRole("button", { name: "Planning", exact: true }).click();
  await page.locator(".category-plan").first().click();
  await expect(page.getByRole("dialog")).toContainText("Monthly trend");
  await page.getByRole("button", { name: "Close category details" }).click();
  await page.getByRole("button", { name: "Savings", exact: true }).click();
  await page.getByRole("button", { name: "Show splits" }).click();
  await expect(page.getByRole("heading", { name: "Account and asset splits" })).toBeVisible();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator(".mobile-flow-map")).toBeVisible();
  await expect(page.locator(".flow-sankey")).toBeHidden();
  const flowViewport = page.locator(".mobile-flow-viewport");
  await expect(flowViewport).toHaveAttribute("data-scale", "1.0");
  await expect(flowViewport).toHaveCSS("touch-action", "pan-y");
  const essentials = page.locator(".mobile-flow-group", { hasText: "Essentials" });
  await essentials.click();
  await expect(essentials).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(flowViewport).toHaveAttribute("data-scale", "1.2");
  const viewportBox = await flowViewport.boundingBox();
  if (!viewportBox) throw new Error("Mobile flow viewport did not render");
  await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + viewportBox.width / 2 - 60, viewportBox.y + 40);
  await page.mouse.up();
  expect(Number(await flowViewport.getAttribute("data-pan-x"))).toBeLessThan(0);
  await page.getByRole("button", { name: "Fit to screen" }).click();
  await expect(flowViewport).toHaveAttribute("data-scale", "1.0");
  await expect(flowViewport).toHaveAttribute("data-pan-x", "0");
  await expect(essentials).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await flowViewport.evaluate((element) => {
    const dispatch = (type: string, id: number, x: number) => element.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: 100, bubbles: true, cancelable: true }));
    dispatch("pointerdown", 1, 80); dispatch("pointerdown", 2, 130);
    dispatch("pointermove", 2, 180); dispatch("pointerup", 1, 80); dispatch("pointerup", 2, 180);
  });
  await expect.poll(async () => Number(await flowViewport.getAttribute("data-scale"))).toBeGreaterThan(1.2);
  await page.getByRole("checkbox", { name: "Split spending by person" }).check();
  await page.getByLabel("Search financial flow").fill("Groceries");
  await page.getByRole("button", { name: "Ariela", exact: true }).click();
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(flowViewport).toHaveAttribute("data-scale", "1.0");
  await expect(page.getByRole("button", { name: "Everyone", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("checkbox", { name: "Split spending by person" })).not.toBeChecked();
  await expect(page.getByLabel("Search financial flow")).toHaveValue("");
  await expect(essentials).toHaveAttribute("aria-expanded", "false");
  const financial = page.locator(".mobile-flow-group", { hasText: "Financial" });
  const lifestyle = page.locator(".mobile-flow-group", { hasText: "Lifestyle" });
  await essentials.click();
  await financial.click();
  await expect(essentials).toHaveAttribute("aria-expanded", "true");
  await expect(financial).toHaveAttribute("aria-expanded", "true");
  const other = page.locator(".mobile-flow-category", { hasText: "Other" });
  await other.click();
  await expect(page.getByRole("dialog")).toContainText("Everyday Checking");
  await expect(page.getByRole("dialog")).toContainText("Shared");
  await page.getByRole("button", { name: "Close category details" }).click();
  await page.getByRole("button", { name: "Collapse all" }).click();
  await lifestyle.click();
  const shopping = page.locator(".mobile-flow-category", { hasText: "Shopping" });
  await page.getByRole("button", { name: "View Shopping details" }).click();
  await expect(page.getByRole("dialog")).toContainText("MACY'S");
  await page.getByRole("button", { name: "Close category details" }).click();
  await shopping.click();
  await expect(shopping).toHaveAttribute("aria-expanded", "true");
  await page.locator(".mobile-flow-subcategory", { hasText: "Clothing" }).click();
  await expect(page.getByRole("dialog")).toContainText("MACY'S");
  await page.getByRole("button", { name: "Close category details" }).click();
  await page.getByRole("button", { name: "Collapse all" }).click();
  await essentials.click();
  await page.getByLabel("Search financial flow").fill("Shopping");
  await expect(lifestyle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".mobile-flow-category.is-search-match", { hasText: "Shopping" })).toBeVisible();
  await page.getByLabel("Search financial flow").fill("");
  await expect(essentials).toHaveAttribute("aria-expanded", "true");
  await expect(lifestyle).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Collapse all" }).click();
  const collapsedHeight = await page.locator(".mobile-flow-stage").evaluate((element) => element.getBoundingClientRect().height);
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect.poll(() => page.locator(".mobile-flow-stage").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(collapsedHeight);
  await page.evaluate(() => window.scrollBy(0, 650));
  await expect.poll(() => page.locator(".viewer-topbar").evaluate((element) => Math.round(element.getBoundingClientRect().bottom))).toBeLessThan(0);
  await expect.poll(() => page.locator(".mobile-flow-toolbar").evaluate((element) => Math.round(element.getBoundingClientRect().bottom))).toBeLessThan(0);
  const lastNode = page.locator(".mobile-flow-node").last();
  await lastNode.scrollIntoViewIfNeeded();
  await expect(lastNode).toBeVisible();
  await page.getByRole("checkbox", { name: "Split spending by person" }).check();
  await expect(page.locator('.mobile-flow-ribbons [aria-label*="Shared, 100.0%"]')).not.toHaveCount(0);
  await page.getByRole("button", { name: "Shared", exact: true }).click();
  await expect(page.locator(".mobile-flow-empty")).toHaveCount(0);
  await page.getByRole("button", { name: "David", exact: true }).click();
  await expect(page.getByText("No spending is assigned to David for this month.")).toBeVisible();
  await page.getByRole("button", { name: "Everyone", exact: true }).click();
  const retained = page.locator(".mobile-flow-terminal", { hasText: "Money retained" });
  await retained.click();
  await expect(retained).toHaveClass(/is-selected/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await essentials.click();
  await financial.click();
  await other.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator(".month-select select").selectOption({ index: 1 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Detailed flow is not available")).toBeVisible();
  await page.locator(".month-select select").selectOption("2026-10");
  await expect(flowViewport).toHaveAttribute("data-scale", "1.0");
  await expect(page.locator(".mobile-flow-group").first()).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement || document.querySelector(".mobile-flow-fullscreen-fallback")))).toBe(true);
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".mobile-flow-stage")).toHaveCSS("transition-duration", "0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".flow-sankey")).toBeVisible();
  await page.getByRole("button", { name: "Focus Essentials" }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Reset view" })).toBeVisible();
  await page.getByRole("button", { name: "Reset view" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await expect(page.getByText(/Save|Edit|Delete|Archive|Sync now|Publish now/)).toHaveCount(0);
  const persistence = await page.evaluate(async () => ({
    local: { ...localStorage }, session: { ...sessionStorage },
    databases: await indexedDB.databases(), caches: await window.caches.keys(),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  expect(persistence).toEqual({ local: {}, session: {}, databases: [], caches: [], workers: 0 });
  expect(consoleText.join(" ")).not.toMatch(/\$|LOWE|snapshot-test/);
});

test("remote viewer shows stale and unavailable states without leaking server details", async ({ page }) => {
  await page.route("**/api/v1/status", (route) => route.fulfill({ json: { available: true, published_at: "2026-10-27T12:01:00Z", stale: true } }));
  await page.goto(viewer);
  await expect(page.getByText("Data may be out of date.")).toBeVisible();

  await page.route("**/api/v1/snapshot", (route) => route.fulfill({ status: 404, json: { error_code: "SNAPSHOT_UNAVAILABLE", private_detail: "must not render" } }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Viewer unavailable" })).toBeVisible();
  await expect(page.getByText("private_detail")).toHaveCount(0);
});
