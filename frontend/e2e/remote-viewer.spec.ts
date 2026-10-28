import { expect, test } from "@playwright/test";

const viewer = "http://127.0.0.1:8789";

test("remote viewer is read-only, responsive, drillable, and leaves no financial browser data", async ({ page }) => {
  const consoleText: string[] = [];
  page.on("console", (message) => consoleText.push(message.text()));
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(viewer);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  for (const section of ["Transactions", "Planning", "Savings", "Reports"]) {
    await page.getByRole("button", { name: section, exact: true }).click();
    await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Transactions", exact: true }).click();
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
  await page.locator(".report-bars button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();

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
