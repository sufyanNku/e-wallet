import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { expect } from "./private-expect";

export async function openWallet(page: Page) {
  const identity = JSON.parse(
    await readFile(".local/secrets/alice.json", "utf8"),
  );
  await page.goto("/import");
  await page
    .getByLabel("Recovery phrase (12 or 24 English words)")
    .fill(identity.mnemonic);
  await page
    .getByLabel("New wallet password", { exact: true })
    .fill("Isolated browser test password");
  await page
    .getByLabel("Confirm new wallet password", { exact: true })
    .fill("Isolated browser test password");
  await page
    .getByRole("button", { name: "Restore wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("dUSDC", { exact: true }).first()).toBeVisible({
    timeout: 20000,
  });
}

export async function walletRoute(page: Page, path: string) {
  await page.evaluate((next) => {
    history.pushState({}, "", next);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.getByRole("heading", { level: 1 }).waitFor();
}
