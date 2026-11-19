import { expect } from "../helpers/private-expect";
import { openWallet } from "../helpers/browser-wallet";
import { test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("wallet search, token filtering, notifications and market discovery remain usable on mobile", async ({
  page,
}) => {
  await page.route("**/api/v1/markets", (route) =>
    route.fulfill({
      json: {
        data: {
          assets: [{ symbol: "ETH", name: "Ethereum", microUsd: "2000000000" }],
          source: "UI test stub",
          observedAt: "2026-11-19T00:00:00Z",
          stale: false,
        },
      },
    }),
  );
  await openWallet(page);
  await expect(
    page.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search tokens", { exact: true }).fill("unlisted");
  await expect(
    page.getByRole("heading", { name: "No matching tokens" }),
  ).toBeVisible();
  await page.getByLabel("Search tokens", { exact: true }).fill("");
  await page
    .getByRole("button", { name: "Search wallet", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Search assets and actions").fill("receive");
  await dialog.getByRole("link", { name: "Receive crypto" }).click();
  await expect(
    page.getByRole("heading", { name: "Receive assets", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("link", { name: "Discover" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Discover", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Ethereum", { exact: true })).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
