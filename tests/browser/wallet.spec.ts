import { test } from "@playwright/test";
import { expect } from "../helpers/private-expect";
import { openWallet, walletRoute } from "../helpers/browser-wallet";
import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile } from "node:fs/promises";
import { JsonRpcProvider } from "ethers";

test("keyboard payment review rejects safely without changing the node balance", async ({
  page,
}) => {
  test.setTimeout(90000);
  await openWallet(page);
  const manifest = JSON.parse(
    await readFile(".local/state/seed/evm-manifest.json", "utf8"),
  );
  const provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, {
    staticNetwork: true,
    cacheTimeout: 0,
  });
  try {
    const before = await provider.getBalance(
      manifest.identities.alice.evm.address,
    );
    await walletRoute(page, "/send");
    await page
      .getByLabel("Recipient address", { exact: true })
      .fill(manifest.identities.bob.evm.address);
    await page.getByLabel("Amount (ETH)", { exact: true }).fill("0.001");
    await page
      .getByRole("button", { name: "Review payment", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Review operation" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(manifest.identities.bob.evm.address, { exact: true }),
    ).toBeVisible();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }
    await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(
      await provider.getBalance(manifest.identities.alice.evm.address),
    ).toBe(before);
  } finally {
    provider.destroy();
  }
});

test("real wallet routes and onboarding fit phone, tablet and desktop widths", async ({
  page,
}) => {
  test.setTimeout(120000);
  await openWallet(page);
  const paths = [
    "/",
    "/tokens",
    "/send",
    "/receive",
    "/contacts",
    "/activity",
    "/collectibles",
    "/apps",
    "/services",
    "/swap",
    "/bridge",
    "/faucet",
    "/vault",
    "/shared",
    "/settings",
    "/evaluation",
  ];
  for (const width of [320, 360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of paths) {
      await walletRoute(page, path);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(await page.locator("body").innerText()).not.toMatch(
        /\bclassroom\b|\buniversity\b|\binstructor\b|\bmock\b/iu,
      );
    }
    for (const path of ["/welcome", "/create", "/import", "/unlock"]) {
      await walletRoute(page, path);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
});

test("built wallet routes remain accessible without a frontend data fallback", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto("/send");
  await expect(page.getByRole("heading", { name: /Your world/ })).toBeVisible();
  await openWallet(page);
  const results = [];
  for (const path of [
    "/",
    "/send",
    "/receive",
    "/contacts",
    "/collectibles",
    "/settings",
    "/connect",
  ]) {
    await walletRoute(page, path);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    results.push({ path, violations: result.violations });
    expect(
      result.violations.map((v) => ({ id: v.id, impact: v.impact })),
    ).toEqual([]);
  }
  await writeFile(
    ".local/reports/web/accessibility.json",
    JSON.stringify(results, null, 2) + "\n",
  );
});

test("receive QR and actual token metadata are checked against the selected network", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await openWallet(page);
  const manifest = JSON.parse(
    await readFile(".local/state/seed/evm-manifest.json", "utf8"),
  );
  const deployment = JSON.parse(
    await readFile(".local/state/deployments/eip155-31337.json", "utf8"),
  );
  await walletRoute(page, "/receive");
  const image = page.getByAltText("QR code of the reviewed receive request");
  await expect(image).toBeVisible();
  const qr = testInfo.outputPath("receive-qr.png");
  await image.screenshot({ path: qr });
  await walletRoute(page, "/send");
  await page.getByLabel("Upload QR image").setInputFiles(qr);
  await expect(
    page.getByLabel("Recipient address", { exact: true }),
  ).toHaveValue(manifest.identities.alice.evm.address);
  await page.getByLabel("QR or address text").fill(
    JSON.stringify({
      address: manifest.identities.bob.evm.address,
      network: "eip155:84532",
      amount: "1",
    }),
  );
  await page
    .getByRole("button", { name: "Read pasted request", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("another network");
  await walletRoute(page, "/tokens");
  await page
    .getByLabel("Contract or mint address")
    .fill(deployment.contracts.Impostor.address);
  await page.getByLabel("Token symbol").fill("USDC");
  await page.getByLabel("Decimals", { exact: true }).fill("6");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Import token", exact: true }).click();
  await expect(page.getByText("USDC", { exact: true })).toBeVisible({
    timeout: 10000,
  });
});
