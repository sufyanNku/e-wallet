import { chooseOption } from "../helpers/select-option";
import { expect } from "../helpers/private-expect";
import { openWallet, walletRoute } from "../helpers/browser-wallet";
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

test("themed network menus support keyboard use, fit phones and keep content beside navigation", async ({
  page,
}) => {
  await openWallet(page);
  const main = await page.locator("main").boundingBox();
  const side = await page.locator(".sidebar").boundingBox();
  expect(main && side ? main.x - side.x - side.width : 999).toBeLessThan(8);
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const network = page.getByLabel("Selected network", { exact: true });
    await network.click();
    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(
      box !== null &&
        box.x >= 0 &&
        box.x + box.width <= width &&
        box.y >= 0 &&
        box.y + box.height <= 900,
    ).toBe(true);
    expect(
      await menu.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).toBe("rgb(33, 27, 41)");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await chooseOption(
    page.getByLabel("Selected network", { exact: true }),
    "bitcoin:regtest",
  );
  await walletRoute(page, "/send");
  await expect(
    page.getByRole("heading", {
      name: "Enable Bitcoin balance access",
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.getByRole("alert").count()).toBe(0);
  await page
    .getByRole("button", { name: "Sign out of wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your wallet is locked", exact: true }),
  ).toBeVisible();
});
