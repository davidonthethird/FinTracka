import { expect, test } from "@playwright/test";

test("synthetic finance workflow", async ({ page }) => {
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
  await expect(page.getByText("Contribution", { exact: true })).toBeVisible();
  await page.getByLabel("Savings owner").selectOption("Ariela");
  await expect(page.getByText("Household brokerage", { exact: true })).toBeVisible();
  await expect(page.getByText("Other reserve", { exact: true })).toHaveCount(0);
  await page.getByLabel("Savings owner").selectOption("");
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
  await expect(page.getByText("1 possible transfer")).toBeVisible();
  await page.getByLabel("Search transactions").fill("TRANSFER");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await page.getByLabel("Include transfers and card payments").check();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.getByLabel("Include transfers and card payments").uncheck();
  await page.getByLabel("Search transactions").fill("LOWE'S");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByLabel("Subcategory for LOWE'S")).toHaveValue(/.+/);
  await expect(page.getByLabel("Subcategory for LOWE'S").locator("option:checked")).toHaveText("Home improvement");
  await page.getByLabel("Correction scope").selectOption("future");
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
  await page.getByLabel("Correction scope").selectOption("past_and_future");
  await page.getByLabel("Subcategory for ATM WITHDRAWAL").selectOption({ label: "Cash withdrawal" });
  await expect(page.getByRole("status")).toContainText("This choice applies once");
  await page.getByLabel("Search transactions").fill("");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: "Confirm transfer" }).click();
  await expect(page.getByRole("status")).toContainText("Transfer confirmed");

  await page.getByLabel("Search transactions").fill("Market");
  await page.getByRole("button", { name: "Search" }).click();
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
  await page.getByLabel("Correction scope").selectOption("one_time");
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
  await expect(page.getByTestId("planning-status")).toContainText(/plan|projected/i);
  await expect(page.getByText(/\d+ of 6 months available/)).toBeVisible();
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
  await expect(page.getByRole("dialog", { name: "Fun planning details" })).toContainText("Subcategory breakdown");
  await page.keyboard.press("Escape");
  await expect(funLane).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /Housing/ }).click();
  await expect(page.getByRole("dialog", { name: "Housing planning details" })).toBeVisible();
  await page.getByLabel("Monthly target").fill("123.45");
  await page.getByLabel("Apply").selectOption("month");
  await page.getByRole("button", { name: "Save target" }).click();
  await page.getByRole("button", { name: /Tzedaka/ }).click();
  await expect(page.getByLabel("Monthly target")).toHaveAttribute("min", "590.00");
  await page.getByRole("button", { name: "Add Tzedaka cash spending" }).click();
  await expect(page.getByRole("dialog", { name: "Add cash spending" }).locator('select[name="category"]')).toHaveValue(/.+/);
  await page.keyboard.press("Escape");

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
  await page.getByRole("button", { name: /Show Fun transactions/ }).click();
  await expect(page.getByRole("dialog", { name: "Fun transactions" })).toBeVisible();
  await page.getByRole("button", { name: "Close flow details" }).click();
  await page.getByRole("button", { name: "Show Lifestyle to Fun transactions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Lifestyle to Fun transactions" })).toBeVisible();
  await page.getByRole("button", { name: "Close flow details" }).click();
  await expect(page.getByRole("heading", { name: "Spending by category" })).toBeVisible();

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
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(["fintracka-theme"]);

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
  await page.route("**/api/v1/providers", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([
      { id: "synthetic", name: "Synthetic", enabled: true },
      { id: "plaid", name: "Plaid", enabled: true, environment: "production" },
    ]),
  }));
  await page.route("**/api/v1/connections", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(plaidConnections) }));
  await page.route("**/api/v1/connections/plaid/sessions", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ link_token: "link-test", expires_at: "2026-10-12T18:00:00Z", environment: "production" }) }));
  await page.route("https://cdn.plaid.com/link/v2/stable/link-initialize.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `window.Plaid={create:function(config){setTimeout(function(){config.onLoad()},0);return{open:function(){setTimeout(function(){config.onSuccess('public-test',{})},0)},exit:function(){},destroy:function(){},submit:function(){}}}};`,
  }));
  await page.route("**/api/v1/connections/plaid/complete", (route) => {
    plaidConnections = [{ id: "plaid-live", provider: "plaid", environment: "production", status: "active", institution_name: "Mock Bank", last_success_at: null, last_error_code: null, updated_at: "2026-10-12T17:00:00Z" }];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(plaidConnections[0]) });
  });
  await page.route("**/api/v1/sync-runs", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ job_id: "job-live" }) }));
  await page.route("**/api/v1/jobs/job-live", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "succeeded" }) }));
  await page.route("**/api/v1/connections/plaid-live/repair", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ link_token: "link-repair", expires_at: "2026-10-12T18:00:00Z", environment: "production" }) }));
  await page.route("**/api/v1/connections/plaid-live", (route) => {
    if (route.request().method() === "DELETE") {
      plaidConnections = plaidConnections.map((item) => ({ ...item, status: "revoked" }));
      return route.fulfill({ status: 204 });
    }
    return route.continue();
  });
  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Connect bank" }).click();
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Connections" }).click();
  await expect(page.getByText("Mock Bank", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details" }).click();
  await page.getByRole("button", { name: "Repair connection" }).click();
  await expect(page.getByRole("status")).toContainText("Sync completed");
  await page.getByRole("button", { name: "Details" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("status")).toContainText("access revoked");

  await page.getByRole("link", { name: "Overview", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Accounts", exact: true })).toBeFocused();

  expect(responseErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
