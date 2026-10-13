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
  await page.getByRole("button", { name: "Save account" }).click();
  await expect(page.getByText("Daily cash", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Transactions" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await expect(page.getByText("1 possible transfer")).toBeVisible();
  await page.getByRole("button", { name: "Confirm transfer" }).click();
  await expect(page.getByRole("status")).toContainText("Transfer confirmed");

  await page.getByLabel("Search transactions").fill("Market");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.locator("tbody input[type=checkbox]").nth(0).check();
  await page.locator("tbody input[type=checkbox]").nth(1).check();
  await page.getByLabel("Categorize selected").selectOption({ label: "Fun" });
  await expect(page.getByRole("cell", { name: "Fun" })).toHaveCount(2);
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

  await page.getByRole("link", { name: "Tracking budget" }).click();
  await expect(page.locator(".budget-grid").getByText("Groceries", { exact: true })).toBeVisible();
  await page.getByLabel("Category").selectOption({ label: "Housing" });
  await page.getByLabel("Monthly target").fill("123.45");
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(page.getByRole("status")).toContainText("Tracking target saved");
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
