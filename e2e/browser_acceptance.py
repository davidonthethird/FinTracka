from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def main() -> None:
    screenshot = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/fintracka-overview.png")
    console_errors: list[str] = []
    page_errors: list[str] = []
    response_errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("response", lambda response: response_errors.append(f"{response.status} {response.url}") if response.status >= 400 else None)

        page.goto("http://127.0.0.1:8787/#bootstrap=browser-test-token")
        page.wait_for_load_state("networkidle")
        assert not response_errors, f"startup HTTP errors: {response_errors}"
        expect(page.get_by_role("heading", name="Overview", exact=True)).to_be_visible()
        assert "bootstrap=" not in page.url
        expect(page.get_by_text("$12,500.00", exact=True).first).to_be_visible()
        page.screenshot(path=str(screenshot), full_page=True)

        page.get_by_role("link", name="Transactions").click()
        page.wait_for_load_state("networkidle")
        expect(page.locator("tbody tr")).to_have_count(100)
        expect(page.get_by_text("1 possible transfer")).to_be_visible()
        page.get_by_role("button", name="Confirm transfer").click()
        expect(page.get_by_role("status")).to_contain_text("Transfer confirmed")
        page.get_by_label("Search transactions").fill("Market")
        page.get_by_role("button", name="Search").click()
        expect(page.locator("tbody tr")).to_have_count(3)
        page.locator("tbody input[type=checkbox]").first.check()
        page.get_by_role("button", name="Split").click()
        expect(page.get_by_role("dialog")).to_be_visible()
        expect(page.get_by_text("Parent total")).to_be_visible()
        page.get_by_role("button", name="Close").click()

        page.get_by_role("link", name="Tracking budget").click()
        expect(page.get_by_role("heading", name="Tracking budget", exact=True)).to_be_visible()
        expect(page.locator(".budget-grid").get_by_text("Groceries", exact=True)).to_be_visible()
        page.get_by_role("link", name="Envelope budget").click()
        expect(page.get_by_role("heading", name="Envelope budget", exact=True)).to_be_visible()
        expect(page.get_by_text("Available to assign")).to_be_visible()
        page.get_by_role("link", name="Reports").click()
        expect(page.get_by_role("heading", name="Reports", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name="Spending by category")).to_be_visible()

        page.get_by_role("link", name="Rules").click()
        expect(page.get_by_role("heading", name="Rules", exact=True)).to_be_visible()
        expect(page.get_by_text("Payroll", exact=True)).to_be_visible()
        page.get_by_role("button", name="Preview", exact=True).click()
        expect(page.get_by_role("status")).to_contain_text("6 eligible transactions")

        page.get_by_role("link", name="Connections").click()
        expect(page.get_by_role("heading", name="Connections", exact=True)).to_be_visible()
        page.get_by_role("button", name="Details").nth(2).click()
        expect(page.get_by_role("dialog")).to_contain_text("Connection detail")
        expect(page.get_by_role("dialog")).to_contain_text("ITEM_LOGIN_REQUIRED")
        page.get_by_role("button", name="Close").click()

        page.get_by_role("link", name="Settings").click()
        page.get_by_role("button", name="Use dark").click()
        expect(page.locator("html")).to_have_attribute("data-theme", "dark")
        page.get_by_role("link", name="Overview", exact=True).focus()
        page.keyboard.press("Tab")
        assert page.evaluate("document.activeElement?.textContent") == "Accounts"

        assert not response_errors, f"HTTP errors: {response_errors}"
        assert not console_errors, f"browser console errors: {console_errors}"
        assert not page_errors, f"browser page errors: {page_errors}"
        browser.close()


if __name__ == "__main__":
    main()
