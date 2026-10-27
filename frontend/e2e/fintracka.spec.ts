import { expect, test } from "@playwright/test";

test("synthetic finance workflow with Plaid profiles edits categories from planning and reports", async ({ page }) => {
  const responseErrors: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) responseErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/#bootstrap=browser-test-token");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByText("$12,500.00", { exact: true }).first()).toBeVisible();
  expect(page.url()).not.toContain("bootstrap=");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
  expect((await page.request.get("/favicon.svg")).ok()).toBeTruthy();

  await page.getByRole("link", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByLabel("Nickname").fill("Daily cash");
  await page.getByLabel("Spending owner").selectOption("Ariela");
  await page.getByRole("button", { name: "Save account" }).click();
  await expect(page.getByText("Daily cash", { exact: true })).toBeVisible();
  await expect(page.locator(".owner-badge").filter({ hasText: "Ariela" })).toBeVisible();

  await page.getByRole("link", { name: "Savings" }).click();
  await expect(page.getByRole("heading", { name: "Savings", exact: true })).toBeVisible();
  await expect(page.getByTestId("savings-combined")).toContainText("$8,500.00");
  await expect(page.getByText("Connected accounts", { exact: true })).toBeVisible();
  await expect(page.getByText("Manually tracked assets", { exact: true })).toBeVisible();
  await expect(page.getByText("Household brokerage", { exact: true })).toBeVisible();
  await expect(page.getByText("Earnings", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Savings owner").selectOption("Ariela");
  await expect(page.getByText("Household brokerage", { exact: true })).toBeVisible();
  await expect(page.getByText("Other reserve", { exact: true })).toHaveCount(0);
  await page.getByLabel("Savings owner").selectOption("");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Preview and start goal tracking" }).click();
  await expect(page.getByText("Your savings goals", { exact: true })).toBeVisible();
  await expect(page.getByText("Emergency", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /Emergency/ }).first().click();
  await expect(page.getByRole("complementary", { name: /Emergency savings details/ })).toContainText("Month-to-month savings");
  await page.getByRole("button", { name: "Close goal details" }).click();
  await page.getByRole("button", { name: "Manage goals" }).click();
  await expect(page.getByRole("heading", { name: "Categories and subcategories" })).toBeVisible();
  await page.getByRole("button", { name: "Allocation & review" }).click();
  await expect(page.getByRole("heading", { name: "Split future savings" })).toBeVisible();
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Add manual asset" }).click();
  let assetDialog = page.getByRole("dialog", { name: "Add manual asset" });
  await assetDialog.getByLabel("Title").fill("Family investment");
  await assetDialog.getByLabel("Type").selectOption("investment");
  await assetDialog.getByLabel("Owner").selectOption("Shared");
  await assetDialog.getByLabel("Current value").fill("123.45");
  await assetDialog.getByLabel("Valuation date").fill("2026-10-14");
  await assetDialog.getByRole("button", { name: "Add asset" }).click();
  await expect(page.getByText("Family investment", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Family investment" }).click();
  assetDialog = page.getByRole("dialog", { name: "Edit manual asset" });
  await assetDialog.getByLabel("Current value").fill("150.00");
  await assetDialog.getByRole("button", { name: "Save asset" }).click();
  await expect(page.getByText("$150.00", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove Family investment" }).click();
  await expect(page.getByText("Family investment", { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Transactions" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.locator("tbody tr").first().locator("td").nth(2).click();
  const transactionDetails = page.getByRole("dialog", { name: "Transaction details" });
  await expect(transactionDetails).toContainText("Account");
  await expect(transactionDetails).toContainText("Institution");
  await expect(transactionDetails).toContainText("Synthetic Bank");
  await transactionDetails.getByRole("button", { name: "Close transaction details" }).click();
  await expect(page.getByRole("button", { name: "Keep visible" })).toBeVisible();
  await page.locator(".transfer-candidate").first().click();
  const transferDetails = page.getByRole("dialog", { name: "Transfer comparison" });
  await expect(transferDetails).toContainText("Money out");
  await expect(transferDetails).toContainText("Money in");
  await expect(transferDetails.getByText("Account", { exact: true })).toHaveCount(2);
  await transferDetails.getByRole("button", { name: "Close transfer details" }).click();
  await page.setViewportSize({ width: 1180, height: 900 });
  await expect.poll(() => page.locator(".sticky-tools").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
  })).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  const accountFilterResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/transactions"
      && Boolean(new URL(response.url()).searchParams.get("account_id")),
  );
  await page.getByLabel("Filter by account").selectOption({ label: "Daily cash" });
  await accountFilterResponse;
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.getByLabel("Filter by account").selectOption("");
  await page.getByRole("button", { name: "This transaction only" }).click();
  const deepCategory = page.locator(".category-cell select").nth(70);
  await deepCategory.scrollIntoViewIfNeeded();
  const scrollBeforeCategoryChange = await page.evaluate(() => window.scrollY);
  expect(scrollBeforeCategoryChange).toBeGreaterThan(500);
  const replacementCategory = await deepCategory.evaluate((select: HTMLSelectElement) =>
    Array.from(select.options).find((option) => option.value && option.value !== select.value)?.value,
  );
  await page.route("**/api/v1/transactions?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  const categoryRefresh = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/transactions",
  );
  await deepCategory.selectOption(replacementCategory!);
  await categoryRefresh;
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBeforeCategoryChange - 200);
  await page.unroute("**/api/v1/transactions?**");
  await page.getByRole("button", { name: "Matching past and future transactions" }).click();
  await expect(page.getByText("1 possible transfer")).toBeVisible();
  await page.getByLabel("Search transactions").fill("TRANSFER");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByLabel("Include confirmed transfers").check();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByLabel("Include confirmed transfers").uncheck();
  await page.getByLabel("Search transactions").fill("LOWE'S");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByLabel("Subcategory for LOWE'S")).toHaveValue(/.+/);
  await expect(page.getByLabel("Subcategory for LOWE'S").locator("option:checked")).toHaveText("Home improvement");
  await page.getByRole("button", { name: "This transaction and future matches" }).click();
  await page.getByRole("button", { name: "Add custom subcategory" }).click();
  await page.getByLabel("New subcategory name").fill("Tools");
  await page.getByRole("button", { name: "Create and choose" }).click();
  await expect(page.getByRole("status")).toContainText("Future matches");
  await expect(page.getByLabel("Subcategory for LOWE'S")).toHaveValue(/.+/);
  await page.getByLabel("Category for LOWE'S", { exact: true }).selectOption({ label: "Dining" });
  await expect(page.getByLabel("Subcategory for LOWE'S")).not.toContainText("Tools");
  await page.getByLabel("Search transactions").fill("MACY'S");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByLabel("Subcategory for MACY'S").locator("option:checked")).toHaveText("Clothing");
  await page.getByLabel("Search transactions").fill("ATM WITHDRAWAL");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: "Matching past and future transactions" }).click();
  await page.getByLabel("Subcategory for ATM WITHDRAWAL").selectOption({ label: "Cash withdrawal" });
  await expect(page.getByRole("status")).toContainText("This choice applies once");
  await page.getByLabel("Search transactions").fill("");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: "Confirm transfer" }).click();
  await expect(page.getByRole("status")).toContainText("Transfer confirmed");

  await page.getByLabel("Search transactions").fill("Market");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Archive" }).first().click();
  await expect(page.getByRole("status")).toContainText("archived");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByLabel("Include archived transactions").check();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("status")).toContainText("restored");
  await page.getByLabel("Include archived transactions").uncheck();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.locator("tbody input[type=checkbox]").nth(0).check();
  await page.locator("tbody input[type=checkbox]").nth(1).check();
  await page.getByLabel("Categorize selected").selectOption({ label: "Fun" });
  await expect(page.getByRole("cell", { name: "Fun" })).toHaveCount(2);
  await page.locator(".owner-cell select").first().selectOption("David");
  await expect(page.getByRole("status")).toContainText("Spending assigned to David");
  await page.getByLabel("Filter spending owner").selectOption("David");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Filter spending owner").selectOption("");
  await page.getByRole("button", { name: "This transaction only" }).click();
  await page.locator(".category-cell select").first().selectOption({ label: "Dining" });
  await expect(page.getByRole("status")).toContainText("This choice applies once");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("status")).toContainText("restored");
  await page.getByLabel("Filter by category").selectOption({ label: "Fun" });
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByLabel("Filter by category").selectOption("");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.locator("tbody input[type=checkbox]").first().check();
  await page.getByRole("button", { name: "Split" }).click();
  await expect(page.getByRole("dialog")).toContainText("Exact-sum editor");
  await page.getByRole("button", { name: "Save exact split" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("Search transactions").fill("");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.getByLabel("Search transactions").fill("Archive fixture");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.getByRole("button", { name: "Load older transactions" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(105);
  await page.getByLabel("Search transactions").fill("");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.getByLabel("Search transactions").fill("Archive fixture");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.route("**/api/v1/transactions**", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Load older transactions" }).click();
  await page.getByLabel("Search transactions").fill("Market");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.getByText(/ARCHIVE FIXTURE/)).toHaveCount(0);
  await page.getByLabel("Search transactions").fill("Archive fixture");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.waitForTimeout(400);
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.unroute("**/api/v1/transactions**");

  await page.getByRole("link", { name: "History import" }).click();
  await page.getByLabel("Account").selectOption({ index: 1 });
  await page.getByLabel("CSV file").setInputFiles({
    name: "older-history.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Transaction Date,Description,Debit,Credit\n09/01/2025,OLDER GROCERIES,22.50,\n"),
  });
  await page.getByRole("button", { name: "Preview history" }).click();
  await expect(page.getByRole("status")).toContainText("1 transaction ready");
  await page.getByRole("button", { name: "Import history" }).click();
  await expect(page.getByRole("status")).toContainText("1 transaction imported");
  await page.getByRole("link", { name: "Transactions" }).click();
  await page.getByLabel("Search transactions").fill("OLDER GROCERIES");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("OLDER GROCERIES", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Planning" }).click();
  const inactiveToggle = page.getByLabel("Show inactive categories");
  await expect(inactiveToggle).toBeVisible();
  await expect(page.locator(".planning-summary")).toContainText("Remaining after targets");
  await expect(page.locator(".planning-summary")).not.toContainText("Planned income");
  await expect(page.getByTestId("spent-so-far").locator("b")).toHaveCSS("color", "rgb(168, 60, 67)");
  await expect(page.getByTestId("remaining-budget").locator("b")).toHaveCSS("color", "rgb(20, 125, 112)");
  const activeCategoryCount = await page.locator(".planning-category").count();
  await inactiveToggle.check();
  await expect(page.locator(".planning-category")).toHaveCount(activeCategoryCount + 9);
  await inactiveToggle.uncheck();
  await page.getByLabel("Title").fill("Paycheck");
  await page.getByLabel("Type").selectOption("Salary");
  await page.getByLabel("Monthly amount").fill("5900.00");
  await page.getByRole("button", { name: "Add income" }).click();
  await expect(page.getByRole("button", { name: "Edit Paycheck" })).toBeVisible();
  await page.getByLabel("Title").fill("Rental");
  await page.getByLabel("Type").selectOption("Custom");
  await page.getByLabel("Monthly amount").fill("1100.00");
  await page.getByRole("button", { name: "Add income" }).click();
  await expect(page.getByRole("button", { name: "Edit Rental" })).toBeVisible();
  await page.getByLabel("Average window").fill("6");
  await expect(page.getByText("Average window:").locator(".." )).toContainText("6 months");
  await expect(page.getByTestId("planning-status")).toContainText("Monthly target");
  await expect(page.getByTestId("planning-status")).not.toContainText(/projected/i);
  await expect(page.getByText(/\d+ of 6 months available/)).toBeVisible();
  await page.getByLabel("Split spending by person").check();
  await expect(page.locator(".owner-lane.owner-david").first()).toBeVisible();
  await page.locator(".owner-lane.owner-david").first().click();
  await expect(page.getByRole("dialog")).toContainText("Category plan · David");
  await page.getByRole("button", { name: "Close" }).click();
  const housingHeight = await page.getByRole("button", { name: /Housing/ }).evaluate((element) => element.getBoundingClientRect().height);
  const funHeight = await page.getByRole("button", { name: /Fun/ }).evaluate((element) => element.getBoundingClientRect().height);
  expect(housingHeight).toBeGreaterThan(funHeight);
  await page.route("**/api/v1/planning/2026-10?**", async (route) => {
    try {
      const owner = new URL(route.request().url()).searchParams.get("spending_owner");
      if (!owner) return await route.continue();
      if (owner === "David") await new Promise((resolve) => setTimeout(resolve, 300));
      const response = await route.fetch();
      const body = await response.json();
      const shopping = body.categories.find((row: { category: string }) => row.category === "Shopping");
      shopping.actual_minor = owner === "David" ? 11_111 : 22_222;
      await route.fulfill({ response, json: body });
    } catch { /* the older request is expected to be aborted */ }
  });
  await page.getByLabel("Spending owner").selectOption("David");
  await page.getByLabel("Spending owner").selectOption("Ariela");
  await expect(page.getByRole("button", { name: /Shopping/ })).toContainText("Spent $222.22");
  await page.unroute("**/api/v1/planning/2026-10?**");
  await page.getByLabel("Spending owner").selectOption("David");
  await expect(page.getByText("Showing David actuals and averages")).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  const funLane = page.getByRole("button", { name: /Fun/ });
  await funLane.focus();
  await page.keyboard.press("Enter");
  const planningDetail = page.getByRole("dialog", { name: "Fun planning details" });
  await expect(planningDetail).toContainText("Subcategory breakdown");
  await expect(planningDetail).not.toContainText("Forecast");
  await page.keyboard.press("Escape");
  await expect(funLane).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /Housing/ }).click();
  await expect(page.getByRole("dialog", { name: "Housing planning details" })).toBeVisible();
  await page.getByLabel("Monthly target").fill("123.45");
  await page.getByRole("dialog", { name: "Housing planning details" }).locator('select[name="scope"]').selectOption("month");
  await page.getByRole("button", { name: "Save target" }).click();
  await page.getByRole("button", { name: /Tzedaka/ }).click();
  await expect(page.getByLabel("Monthly target")).toHaveAttribute("min", "590.00");
  await page.getByRole("button", { name: "Add Tzedaka cash spending" }).click();
  await expect(page.getByRole("dialog", { name: "Add cash spending" }).locator('select[name="category"]')).toHaveValue(/.+/);
  await page.keyboard.press("Escape");

  await page.getByLabel("Spending owner").selectOption("");
  const shoppingLane = page.getByRole("button", { name: /Shopping/ });
  await shoppingLane.click();
  const planningDrawer = page.getByRole("dialog", { name: "Shopping planning details" });
  await planningDrawer.getByRole("button", { name: "Matching past and future transactions" }).click();
  const drawerRowsBefore = await planningDrawer.getByRole("button", { name: /Edit category for/ }).count();
  const firstEdit = planningDrawer.getByRole("button", { name: /Edit category for/ }).first();
  await firstEdit.click();
  const categoryEditor = planningDrawer.getByLabel(/Category for/).first();
  let rejectOnce = true;
  await page.route("**/api/v1/transactions/*/categorize", async (route) => {
    if (rejectOnce) {
      rejectOnce = false;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "transaction changed; refresh and retry" }) });
    }
    return route.continue();
  });
  await categoryEditor.selectOption({ label: "Dining" });
  await expect(planningDrawer.getByRole("alert")).toContainText("transaction changed");
  expect(responseErrors.pop()).toMatch(/^409 .*\/categorize$/);
  expect(consoleErrors.pop()).toContain("409 (Conflict)");
  await expect(categoryEditor).toBeVisible();
  const scrollBeforeDrawerSave = await page.evaluate(() => window.scrollY);
  const categorizeResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/categorize") && response.status() === 200);
  await categoryEditor.selectOption({ label: "Fun" });
  const categorized = await categorizeResponse;
  expect(categorized.request().postDataJSON().scope).toBe("past_and_future");
  await expect(planningDrawer.getByRole("status")).toContainText(/transaction.*categorized/i);
  await expect(planningDrawer).toBeVisible();
  await expect(planningDrawer.getByRole("button", { name: /Edit category for/ })).toHaveCount(drawerRowsBefore - 1);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBeforeDrawerSave);
  await expect(page.getByRole("button", { name: /Shopping/ })).toHaveCount(0);
  await page.unroute("**/api/v1/transactions/*/categorize");
  await planningDrawer.getByRole("button", { name: "Close" }).click();

  await page.getByRole("link", { name: "Transactions" }).click();
  await page.getByRole("button", { name: "Add cash spending" }).click();
  let cashDialog = page.getByRole("dialog", { name: "Add cash spending" });
  await cashDialog.getByLabel("Title").fill("Cash tzedaka");
  await cashDialog.getByLabel("Amount").fill("25.00");
  await cashDialog.locator('select[name="category"]').selectOption({ label: "Tzedaka" });
  await expect(cashDialog.getByLabel("Spent by")).toHaveValue("Shared");
  await cashDialog.getByRole("button", { name: "Add spending" }).click();
  await page.getByLabel("Search transactions").fill("Cash tzedaka");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Cash tzedaka", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  cashDialog = page.getByRole("dialog", { name: "Edit cash spending" });
  await cashDialog.getByLabel("Amount").fill("26.00");
  await cashDialog.getByRole("button", { name: "Save changes" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("status")).toContainText("Manual cash spending deleted");
  await page.getByRole("link", { name: "Envelope budget" }).click();
  await expect(page.getByText("Available to assign")).toBeVisible();
  await page.getByLabel("Month pool").fill("3000.00");
  await page.getByLabel("Category").selectOption({ label: "Housing" });
  await page.getByLabel("Allocation").fill("500.00");
  await page.getByRole("button", { name: "Save allocation" }).click();
  await expect(page.getByRole("status")).toContainText("Envelope allocation saved");
  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("heading", { name: "Income and spending flow" })).toBeVisible();
  const funFlowButton = page.getByRole("button", { name: /Show Fun transactions/ });
  const funFlowNode = funFlowButton.locator("..");
  const funFlowBefore = await funFlowNode.textContent();
  await funFlowButton.click();
  let reportDrawer = page.getByRole("dialog", { name: "Fun transactions" });
  await reportDrawer.getByRole("button", { name: "This transaction and future matches" }).click();
  const reportRowsBefore = await reportDrawer.getByRole("button", { name: /Edit category for/ }).count();
  await reportDrawer.getByRole("button", { name: /Edit category for/ }).first().click();
  const reportCategoryEditor = reportDrawer.getByLabel(/Category for/).first();
  await page.route("**/api/v1/reports/flow?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  const reportCategorizeResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/categorize") && response.status() === 200);
  await reportCategoryEditor.selectOption({ label: "Dining" });
  const reportCategorized = await reportCategorizeResponse;
  expect(reportCategorized.request().postDataJSON().scope).toBe("future");
  await page.waitForTimeout(100);
  expect(await reportDrawer.isVisible()).toBe(true);
  await expect(reportDrawer.getByRole("button", { name: /Edit category for/ })).toHaveCount(reportRowsBefore - 1);
  await page.unroute("**/api/v1/reports/flow?**");
  await expect(funFlowNode).not.toHaveText(funFlowBefore || "");
  await reportDrawer.getByRole("button", { name: "Undo" }).click();
  await expect(reportDrawer.getByRole("button", { name: /Edit category for/ })).toHaveCount(reportRowsBefore);
  await expect(funFlowNode).toHaveText(funFlowBefore || "");
  await reportDrawer.getByRole("button", { name: "Close flow details" }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Income and spending flow" })).toBeVisible();
  await page.getByRole("button", { name: /Show Fun transactions/ }).click();
  reportDrawer = page.getByRole("dialog", { name: "Fun transactions" });
  await expect(reportDrawer.getByRole("button", { name: "This transaction and future matches" })).toHaveAttribute("aria-pressed", "true");
  await reportDrawer.getByRole("button", { name: "Close flow details" }).click();
  const singletonCategory = await page.evaluate(async () => {
    const response = await fetch("/api/v1/reports/flow?month=2026-10");
    const report = await response.json();
    return report.nodes.find((node: { kind: string; label: string; entry_ids: string[] }) => node.kind === "expense" && node.label !== "Fun" && node.entry_ids.length === 1)?.label as string;
  });
  expect(singletonCategory).toBeTruthy();
  await page.getByRole("button", { name: `Show ${singletonCategory} transactions`, exact: true }).click();
  const singletonDrawer = page.getByRole("dialog", { name: `${singletonCategory} transactions` });
  await singletonDrawer.getByRole("button", { name: /Edit category for/ }).click();
  const singletonEditor = singletonDrawer.getByLabel(/Category for/);
  const singletonReplacement = await singletonEditor.evaluate((select: HTMLSelectElement) =>
    Array.from(select.options).find((option) => option.value && option.value !== select.value)?.value,
  );
  const singletonSave = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/categorize") && response.status() === 200);
  await singletonEditor.selectOption(singletonReplacement!);
  await singletonSave;
  await expect(singletonDrawer.getByRole("button", { name: "Undo" })).toBeVisible();
  await singletonDrawer.getByRole("button", { name: "Undo" }).click();
  await expect(singletonDrawer.getByRole("button", { name: /Edit category for/ })).toHaveCount(1);
  await singletonDrawer.getByRole("button", { name: "Close flow details" }).click();
  await page.getByRole("button", { name: "Show Lifestyle to Fun transactions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Lifestyle to Fun transactions" })).toBeVisible();
  await page.getByRole("button", { name: "Close flow details" }).click();
  await expect(page.getByRole("heading", { name: "Spending by category" })).toBeVisible();
  await page.getByLabel("Split spending by person").check();
  await page.locator(".owner-spending .owner-ariela").click();
  await expect(page.getByRole("heading", { name: "Spending by category · Ariela" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ariela transactions" })).toBeVisible();

  await page.getByRole("link", { name: "Rules" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("eligible transactions");
  await page.getByLabel("Name").fill("Archive purchases");
  await page.getByLabel("Priority").fill("30");
  await page.getByLabel("Description contains").fill("ARCHIVE FIXTURE");
  await page.getByLabel("Assign category").selectOption({ label: "Fun" });
  await page.getByRole("button", { name: "Create without reprocessing" }).click();
  await expect(page.getByRole("status")).toContainText("Rule created");
  await expect(page.getByText("Archive purchases", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Details" }).nth(2).click();
  await expect(page.getByRole("dialog")).toContainText("ITEM_LOGIN_REQUIRED");
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Use dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Export now" }).click();
  await expect(page.getByRole("status")).toContainText("Excel export succeeded", { timeout: 15_000 });
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByRole("status")).toContainText("Backup succeeded", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Live-data readiness" })).toBeVisible();
  await expect(page.getByText("Off-device backup", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(["fintracka-categorization-scope", "fintracka-theme"]);

  let googleAuthorized = false;
  let scheduleInstalled = false;
  await page.route("**/api/v1/settings", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ reporting_currency: "USD", reporting_timezone: "America/New_York", localhost_only: true, google_configured: true, google_authorized: googleAuthorized, schedule_installed: scheduleInstalled, schedule_loaded: scheduleInstalled }),
  }));
  await page.route("**/api/v1/exports/google/authorize", (route) => {
    googleAuthorized = true;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ job_id: "job-google" }) });
  });
  await page.route("**/api/v1/jobs/job-google", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "succeeded" }) }));
  await page.route("**/api/v1/settings/schedule", (route) => {
    scheduleInstalled = route.request().method() === "POST";
    return route.fulfill({ status: scheduleInstalled ? 200 : 204, contentType: "application/json", body: scheduleInstalled ? JSON.stringify({ installed: true, loaded: true }) : "" });
  });
  await page.reload();
  await page.getByRole("button", { name: "Authorize Google" }).click();
  await expect(page.getByRole("status")).toContainText("Google authorization succeeded");
  await expect(page.getByRole("button", { name: "Export to Google" })).toBeVisible();
  await page.getByRole("button", { name: "Install schedule" }).click();
  await expect(page.getByRole("status")).toContainText("Daily sync installed");
  await expect(page.getByRole("button", { name: "Remove schedule" })).toBeVisible();

  let plaidConnections: Array<Record<string, string | null>> = [];
  let arielaConfigured = false;
  const sessionProfiles: string[] = [];
  const completedProfiles: string[] = [];
  await page.route("**/api/v1/providers", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([
      { id: "synthetic", name: "Synthetic", enabled: true },
      { id: "plaid", name: "Plaid", enabled: true, profiles: [
        { id: "david", label: "David", configured: true, environment: "production" },
        { id: "ariela", label: "Ariela", configured: arielaConfigured, ...(arielaConfigured ? { environment: "sandbox" } : {}) },
      ] },
    ]),
  }));
  await page.route("**/api/v1/connections", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(plaidConnections) }));
  await page.route("**/api/v1/connections/plaid/sessions", (route) => {
    const profile = route.request().postDataJSON().profile as string;
    sessionProfiles.push(profile);
    const environment = profile === "david" ? "production" : "sandbox";
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ link_token: `link-${profile}`, expires_at: "2026-10-12T18:00:00Z", environment }) });
  });
  await page.route("https://cdn.plaid.com/link/v2/stable/link-initialize.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `window.Plaid={create:function(config){setTimeout(function(){config.onLoad()},0);return{open:function(){setTimeout(function(){config.onSuccess(config.token==='link-david'?'public-production':'public-sandbox',{})},0)},exit:function(){},destroy:function(){},submit:function(){}}}};`,
  }));
  await page.route("**/api/v1/connections/plaid/complete", (route) => {
    const payload = route.request().postDataJSON() as { profile: string; public_token: string };
    completedProfiles.push(payload.profile);
    const item = { id: `plaid-${payload.profile}`, provider: "plaid", credential_profile: payload.profile, environment: payload.profile === "david" ? "production" : "sandbox", status: "active", institution_name: `${payload.profile === "david" ? "David" : "Ariela"} Mock Bank`, last_success_at: null, last_error_code: null, updated_at: "2026-10-12T17:00:00Z" };
    plaidConnections = [...plaidConnections, item];
    if (payload.profile === "david") arielaConfigured = true;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(item) });
  });
  await page.route("**/api/v1/sync-runs", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ job_id: "job-live" }) }));
  await page.route("**/api/v1/jobs/job-live", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "succeeded" }) }));
  await page.route("**/api/v1/connections/plaid-david/repair", (route) => {
    expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ link_token: "link-repair", expires_at: "2026-10-12T18:00:00Z", environment: "production" }) });
  });
  await page.route("**/api/v1/connections/plaid-david", (route) => {
    if (route.request().method() === "DELETE") {
      expect(route.request().postData()).toBeNull();
      plaidConnections = plaidConnections.map((item) => item.id === "plaid-david" ? { ...item, status: "revoked" } : item);
      return route.fulfill({ status: 204 });
    }
    return route.continue();
  });
  await page.getByRole("link", { name: "Connections" }).click();
  await expect(page.getByRole("button", { name: "Connect bank as Ariela" })).toBeDisabled();
  await page.getByRole("button", { name: "Connect bank as David" }).click();
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Connections" }).click();
  await expect(page.getByText("David Mock Bank", { exact: true })).toBeVisible();
  await expect(page.getByText("Plaid profile: David", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Connect bank as Ariela" }).click();
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Connections" }).click();
  await expect(page.getByText("Ariela Mock Bank", { exact: true })).toBeVisible();
  expect(sessionProfiles).toEqual(["david", "ariela"]);
  expect(completedProfiles).toEqual(["david", "ariela"]);
  await page.locator(".connection-row").filter({ hasText: "David Mock Bank" }).getByRole("button", { name: "Details" }).click();
  await expect(page.getByText("David", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Manage bank accounts" }).click();
  await expect(page.getByRole("status")).toContainText("Sync completed");
  await page.locator(".connection-row").filter({ hasText: "David Mock Bank" }).getByRole("button", { name: "Details" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("status")).toContainText("access revoked");
  await page.getByRole("link", { name: "Transactions" }).click();
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Overview", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Accounts", exact: true })).toBeFocused();

  expect(responseErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
