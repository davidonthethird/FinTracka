import { expect, test } from "@playwright/test";

test("synthetic finance workflow", async ({ page }) => {
  const responseErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) responseErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

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
  await expect(page.locator("tbody tr")).toHaveCount(8);
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
  await page.locator("tbody input[type=checkbox]").first().check();
  await page.getByRole("button", { name: "Split" }).click();
  await expect(page.getByRole("dialog")).toContainText("Exact-sum editor");
  await page.getByRole("button", { name: "Save exact split" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("link", { name: "Tracking budget" }).click();
  await expect(page.locator(".budget-grid").getByText("Groceries", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Envelope budget" }).click();
  await expect(page.getByText("Available to assign")).toBeVisible();
  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("heading", { name: "Spending by category" })).toBeVisible();

  await page.getByRole("link", { name: "Rules" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("eligible transactions");

  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Details" }).nth(2).click();
  await expect(page.getByRole("dialog")).toContainText("ITEM_LOGIN_REQUIRED");
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Use dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Export now" }).click();
  await expect(page.getByRole("status")).toContainText("Export succeeded", { timeout: 15_000 });
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByRole("status")).toContainText("Backup succeeded", { timeout: 15_000 });
  await page.getByRole("link", { name: "Overview", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Accounts", exact: true })).toBeFocused();

  expect(responseErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
