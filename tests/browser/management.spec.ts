import { test, expect } from "@playwright/test";

test("accounts, contacts, network scoping and balance privacy remain usable", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore wallet", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your wallet", exact: true })
    .waitFor();
  const route = async (path: string) => {
    await page.evaluate((value) => {
      history.pushState({}, "", value);
      dispatchEvent(new PopStateEvent("popstate"));
    }, path);
  };
  await page.getByRole("button", { name: "Hide amounts", exact: true }).click();
  await expect(page.locator(".total")).toContainText("••••••");
  await page.getByRole("button", { name: "Show amounts", exact: true }).click();
  await expect(page.locator(".total")).toContainText("$");

  await page
    .getByRole("button", { name: "Manage accounts", exact: true })
    .click();
  const accounts = page.getByRole("dialog", { name: "Your accounts" });
  await accounts.getByLabel("Account name", { exact: true }).fill("Savings");
  await accounts
    .getByRole("button", { name: "Add derived account", exact: true })
    .click();
  await expect(
    accounts.getByRole("button", { name: "Savings · 2", exact: true }),
  ).toBeVisible();
  await accounts
    .getByRole("button", { name: "Savings · 2", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Manage accounts", exact: true }),
  ).toContainText("Savings");
  await page
    .getByRole("button", { name: "Manage accounts", exact: true })
    .click();
  await accounts.getByLabel("Account name", { exact: true }).fill("Travel");
  await accounts
    .locator(".account-row")
    .filter({ hasText: "Savings · 2" })
    .getByRole("button", { name: "Rename using name below", exact: true })
    .click();
  await expect(
    accounts.getByRole("button", { name: "Travel · 2", exact: true }),
  ).toBeVisible();
  await accounts
    .getByRole("button", { name: "Travel · 2", exact: true })
    .click();

  await route("/contacts");
  await page.getByLabel("Contact label", { exact: true }).fill("Lab partner");
  await page
    .getByLabel("Full address", { exact: true })
    .fill("0x2222222222222222222222222222222222222222");
  await page.getByRole("button", { name: "Save contact", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit Lab partner", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit Lab partner", exact: true })
    .click();
  await page.getByLabel("Contact label", { exact: true }).fill("Study partner");
  await page.getByRole("button", { name: "Save contact", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit Study partner", exact: true }),
  ).toBeVisible();
  await route("/send");
  await page
    .getByLabel("Choose a saved contact", { exact: true })
    .selectOption({ label: "Study partner" });
  await expect(
    page.getByLabel("Recipient address", { exact: true }),
  ).toHaveValue("0x2222222222222222222222222222222222222222");
  await page
    .getByLabel("Selected network", { exact: true })
    .selectOption("solana:local");
  await route("/contacts");
  await expect(
    page.getByRole("button", { name: "Edit Study partner", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Selected network", { exact: true })
    .selectOption("eip155:31337");
  await page
    .getByRole("button", { name: "Delete Study partner", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit Study partner", exact: true }),
  ).toHaveCount(0);
});
