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
    const viewerNavigation = page.getByRole("navigation", { name: "Viewer sections" });
    await expect(viewerNavigation.getByRole("button")).toHaveCount(5);
    if (width === 320) {
      const navigationBounds = await viewerNavigation.evaluate((element) => {
        const bar = element.getBoundingClientRect();
        const buttons = [...element.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
        return {
          oneRow: new Set(buttons.map((button) => Math.round(button.top))).size === 1,
          contained: buttons.every((button) => button.left >= bar.left && button.right <= bar.right && button.bottom <= bar.bottom),
        };
      });
      expect(navigationBounds).toEqual({ oneRow: true, contained: true });
    }
    await page.getByRole("button", { name: "Transactions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
    if (width === 320) {
      await page.getByRole("button", { name: /Scan receipt/ }).click();
      await expect(page.getByRole("heading", { name: "Receipts", exact: true })).toBeVisible();
      await expect(viewerNavigation.getByRole("button", { name: "Transactions", exact: true })).toHaveClass(/active/);
      await viewerNavigation.getByRole("button", { name: "Transactions", exact: true }).click();
    }
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

test("authorized household members can choose a scope, replace, and cancel a classification", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${viewer}/transactions`);
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  await page.getByLabel("Search transactions").fill("LOWE");
  await page.locator(".transaction-entry").click();
  await page.getByRole("button", { name: "Edit classification" }).click();
  await expect(page.getByRole("button", { name: "Past + future" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Search categories").fill("Grocer");
  await page.getByRole("listbox", { name: "Category" }).getByRole("option", { name: "Groceries", exact: true }).click();
  await expect(page.locator(".classification-preview")).toContainText("Shopping / Home improvement → Groceries");
  await page.getByRole("button", { name: "Save proposal" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("Pending", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Proposed classification")).toBeVisible();
  await expect(drawer.locator(".proposal-row")).toContainText("Groceries");
  await expect(drawer.locator(".proposal-row")).toContainText("Past + future");
  await page.getByRole("button", { name: "Close transaction details" }).click();
  await expect(page.locator(".transaction-entry")).toContainText("Pending proposal");

  await page.locator(".transaction-entry").click();
  await page.getByRole("button", { name: "Replace proposal" }).click();
  await page.getByRole("button", { name: "One time" }).click();
  await page.getByLabel("Search categories").fill("Other");
  await page.getByRole("listbox", { name: "Category" }).getByRole("option", { name: "Other", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Replace proposal" }).click();
  await expect(page.getByRole("dialog").locator(".proposal-row")).toContainText("Other");
  await expect(page.getByRole("dialog").locator(".proposal-row")).toContainText("One time");

  await page.getByRole("button", { name: "Close transaction details" }).click();
  await page.getByRole("button", { name: "Planning", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Planning", exact: true })).toBeVisible();
  await expect(page.getByText("Pending proposal")).toHaveCount(0);
  await page.getByRole("button", { name: "Transactions", exact: true }).click();
  await page.getByLabel("Search transactions").fill("LOWE");
  await page.locator(".transaction-entry").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel proposal" }).click();
  await expect(page.getByRole("dialog").getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit classification" })).toBeVisible();
});

test("iPhone receipt Shortcut handoff imports populated text without loading browser OCR", async ({ page }) => {
  const ocrRequests: string[] = [];
  page.on("request", (request) => { if (/receipt-ocr|paddle|onnx/i.test(request.url())) ocrRequests.push(request.url()); });
  await page.route("**/api/v1/mobile/receipt-scan-sessions", (route) => route.fulfill({ status: 201, json: {
    contract: "receipt_scan_session/v1", shortcut_version: 2,
    shortcut_name: "FinTracka Receipt Scanner", token: "a".repeat(43),
    upload_url: `${viewer}/api/v1/mobile/shortcut/receipt-imports`, expires_at: "2026-11-02T12:10:00.000Z",
  } }));
  await page.goto(`${viewer}/receipts/new`);
  const launch = page.getByRole("link", { name: "Scan with iPhone" });
  await expect(launch).toBeVisible();
  const shortcutUrl = new URL(await launch.getAttribute("href") ?? "");
  expect(shortcutUrl.protocol).toBe("shortcuts:");
  expect(shortcutUrl.searchParams.get("name")).toBe("FinTracka Receipt Scanner");
  expect(page.locator('input[type="file"]')).toHaveCount(0);

  const imported = { id: "00000000-0000-4000-8000-000000000001", shortcut_version: 1,
    pages: [{ page_index: 0, text: "SYNTHETIC MARKET\nAPPLES 4.50\nTOTAL 4.50" }],
    created_at: "2026-11-02T12:00:00.000Z", expires_at: "2026-11-02T12:30:00.000Z" };
  let createdBody: any;
  await page.route(`**/api/v1/mobile/receipt-imports/${imported.id}`, async (route) => {
    if (route.request().method() === "DELETE") await route.fulfill({ status: 204, body: "" });
    else await route.fulfill({ json: { import: imported } });
  });
  await page.route("**/api/v1/mobile/receipts", async (route) => {
    createdBody = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { draft: { ...createdBody.draft, id: "shortcut-draft-1",
      revision: 1, digest: "a".repeat(64), created_at: "2026-11-02", updated_at: "2026-11-02",
      retention_at: "2027-01-31" }, replayed: false } });
  });
  await page.goto(`${viewer}/receipts/import/${imported.id}`);
  await expect(page.getByRole("heading", { name: "Receipt details" })).toBeVisible();
  expect(createdBody.idempotency_key).toBe(`shortcut-import-${imported.id}`);
  expect(createdBody.draft).toMatchObject({ merchant: "SYNTHETIC MARKET", total_minor: 450 });
  expect(ocrRequests).toEqual([]);
});

test("receipt model comparison waits for an explicit choice before creating a draft", async ({ page }) => {
  const importId = "00000000-0000-4000-8000-000000000005";
  const validation = {
    status: "accepted" as const,
    issues: [],
    receipt: {
      merchant: { value: "SYNTHETIC MARKET", evidence: "SYNTHETIC MARKET" },
      date: null,
      subtotal: { value_cents: 450, evidence: "4.50" },
      discounts: [], tax: null, tip: null, fees: [],
      total: { value_cents: 450, evidence: "TOTAL 4.50" },
      lines: [{ description: "APPLES", amount_cents: 450,
        description_evidence: "APPLES", amount_evidence: "4.50" }],
    },
  };
  let selection: "on_device" | null = null;
  let createCalls = 0;
  await page.route(`**/api/v1/mobile/receipt-imports/${importId}/selection`, async (route) => {
    selection = "on_device";
    await route.fulfill({ json: { import: { id: importId } } });
  });
  await page.route(`**/api/v1/mobile/receipt-imports/${importId}`, async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 204, body: "" }); return;
    }
    await route.fulfill({ json: { import: {
      id: importId, shortcut_version: 3, selection,
      pages: [{ page_index: 0, text: "SYNTHETIC MARKET\nAPPLES 4.50\nTOTAL 4.50" }],
      validation: selection ? validation : null,
      comparison: { recommendation: "tie", material_disagreement: false, runs: [
        { model: "on_device", status: "completed", duration_ms: 1200, validation },
        { model: "private_cloud_compute", status: "completed", duration_ms: 1800, validation },
      ] },
      created_at: "2026-11-08T12:00:00.000Z", expires_at: "2026-11-08T12:30:00.000Z",
    } } });
  });
  await page.route("**/api/v1/mobile/receipts", async (route) => {
    createCalls += 1;
    const body = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { draft: { ...body.draft, id: "comparison-draft-1",
      revision: 1, digest: "a".repeat(64), created_at: "2026-11-08", updated_at: "2026-11-08",
      retention_at: "2027-02-06" }, replayed: false } });
  });

  await page.goto(`${viewer}/receipts/import/${importId}`);
  await expect(page.getByRole("heading", { name: "Compare Apple results" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "On-device" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Private Cloud Compute" })).toBeVisible();
  expect(createCalls).toBe(0);

  await page.getByRole("button", { name: "Use On-device" }).click();
  await expect(page.getByRole("heading", { name: "Receipt details" })).toBeVisible();
  expect(createCalls).toBe(1);
});

test("leaving a receipt import before it loads does not create a draft", async ({ page }) => {
  const importId = "00000000-0000-4000-8000-000000000004";
  let releaseImport!: () => void;
  const importReleased = new Promise<void>((resolve) => { releaseImport = resolve; });
  let createCalls = 0;
  await page.route(`**/api/v1/mobile/receipt-imports/${importId}`, async (route) => {
    await importReleased;
    await route.fulfill({ json: { import: {
      id: importId, shortcut_version: 1,
      pages: [{ page_index: 0, text: "SYNTHETIC MARKET\nAPPLES 4.50\nTOTAL 4.50" }],
      created_at: "2026-11-02T12:00:00.000Z", expires_at: "2026-11-02T12:30:00.000Z",
    } } });
  });
  await page.route("**/api/v1/mobile/receipts", (route) => {
    createCalls += 1;
    return route.abort();
  });

  await page.goto(`${viewer}/receipts/import/${importId}`);
  await page.getByRole("navigation", { name: "Viewer sections" })
    .getByRole("button", { name: "Transactions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  releaseImport();
  await page.waitForTimeout(100);

  expect(createCalls).toBe(0);
});

test("receipt import keeps unusable text reviewable and explains expired imports", async ({ page }) => {
  const unusableId = "00000000-0000-4000-8000-000000000002";
  let createCalls = 0;
  await page.route(`**/api/v1/mobile/receipt-imports/${unusableId}`, (route) => route.fulfill({ json: { import: {
    id: unusableId, shortcut_version: 1, pages: [{ page_index: 0, text: "###\n---" }],
    created_at: "2026-11-02T12:00:00.000Z", expires_at: "2026-11-02T12:30:00.000Z",
  } } }));
  await page.route("**/api/v1/mobile/receipts", (route) => { createCalls += 1; return route.abort(); });
  await page.goto(`${viewer}/receipts/import/${unusableId}`);
  const unusable = page.getByRole("alert");
  await expect(unusable).toContainText("did not contain a usable");
  await expect(unusable).toBeFocused();
  await page.getByText("Show recognized text").click();
  await expect(page.locator(".receipt-recognized-text pre")).toContainText("###");
  expect(createCalls).toBe(0);

  const expiredId = "00000000-0000-4000-8000-000000000003";
  await page.route(`**/api/v1/mobile/receipt-imports/${expiredId}`, (route) => route.fulfill({
    status: 404, json: { error_code: "RECEIPT_IMPORT_NOT_FOUND" },
  }));
  await page.goto(`${viewer}/receipts/import/${expiredId}`);
  const expired = page.getByRole("alert");
  await expect(expired).toContainText("expired or was already removed");
  await expect(expired).toBeFocused();
  await page.getByRole("button", { name: "Start a new scan" }).click();
  await expect(page.getByRole("heading", { name: "Scan receipt" })).toBeVisible();
});

test("receipt inbox confirms safe removal and refreshes after a revision conflict", async ({ page }) => {
  const draft = (id: string, merchant: string) => ({ contract: "receipt_draft/v1", status: "editing",
    merchant, purchase_date: "2026-11-02", currency: "USD", masked_payment_hint: null, page_count: 1,
    subtotal_minor: 450, discount_minor: 0, tax_minor: 0, tip_minor: 0, fees_minor: 0, total_minor: 450,
    lines: [], id, revision: 1, digest: "a".repeat(64), created_at: "2026-11-02",
    updated_at: "2026-11-02", retention_at: "2027-01-31" });
  let drafts = [draft("remove-1", "Remove Market"), draft("conflict-1", "Conflict Market")];
  await page.route("**/api/v1/mobile/session", (route) => route.fulfill({ json: {
    member: { id: "member-fixture", display_name: "Fixture member" },
    capabilities: { "receipts.drafts": [1] }, server_time: new Date().toISOString(),
  } }));
  await page.route("**/api/v1/mobile/receipts", (route) => route.fulfill({ json: { drafts } }));
  await page.route("**/api/v1/mobile/receipts/remove-1/dismiss", async (route) => {
    const removed = { ...drafts[0], status: "dismissed", revision: 2 };
    drafts = drafts.map((item) => item.id === removed.id ? removed : item);
    await route.fulfill({ json: { draft: removed } });
  });
  await page.route("**/api/v1/mobile/receipts/conflict-1/dismiss", async (route) => {
    drafts = drafts.map((item) => item.id === "conflict-1" ? { ...item, status: "conflict", revision: 2 } : item);
    await route.fulfill({ status: 409, json: { error_code: "RECEIPT_REVISION_CONFLICT" } });
  });
  await page.goto(`${viewer}/receipts`);
  await expect(page.getByRole("button", { name: "Open Remove Market receipt" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove Remove Market receipt" }).click();
  await expect(page.getByRole("button", { name: "Open Remove Market receipt" })).toHaveCount(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove Conflict Market receipt" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be removed");
  await expect(page.getByRole("button", { name: "Open Conflict Market receipt" })).toBeVisible();
  await expect(page.locator(".receipt-inbox-row", { hasText: "Conflict Market" })).toContainText("Needs review");
});
