import { expect } from "../helpers/private-expect";
import { test, type Page } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import vectors from "../../fixtures/derivation-vectors.json" with { type: "json" };
import { walletRoute } from "../helpers/browser-wallet";
const password = "Public vector-only test password",
  nextPassword = "Changed vector-only test password";
async function restore(page: Page) {
  await page.goto("/import");
  await page
    .getByLabel("Recovery phrase (12 or 24 English words)")
    .fill(vectors.mnemonic.split(" ").join(", "));
  await page.getByLabel("New wallet password", { exact: true }).fill(password);
  await page
    .getByLabel("Confirm new wallet password", { exact: true })
    .fill(password);
  await page
    .getByRole("button", { name: "Restore wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
}
async function settings(page: Page) {
  await page.locator('a[href="/settings"]').first().click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
}
test("real Worker creates a wallet, verifies recovery backup and locks on reload", async ({
  page,
}) => {
  await page.goto("/create");
  await page.getByLabel("Wallet password", { exact: true }).fill(password);
  await page
    .getByLabel("Confirm wallet password", { exact: true })
    .fill(password);
  for (const label of ["Wallet password", "Confirm wallet password"]) {
    const field = page.getByLabel(label, { exact: true });
    expect(await field.getAttribute("type")).toBe("password");
    await page
      .getByRole("button", { name: "Show " + label, exact: true })
      .click();
    expect(await field.getAttribute("type")).toBe("text");
    await expect(field).toHaveValue(password);
    await page
      .getByRole("button", { name: "Hide " + label, exact: true })
      .click();
    expect(await field.getAttribute("type")).toBe("password");
  }

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Back up your recovery phrase" }),
  ).toBeVisible();
  // No screenshots, tracing, video, or phrase logging; the temporary browser
  // profile is destroyed by Playwright after this test.
  const words = await page
    .locator(".word-grid>div")
    .evaluateAll((elements) =>
      elements.map((el) => el.childNodes[1].textContent ?? ""),
    );
  expect(words.length).toBe(24);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  for (const field of await page.getByLabel(/^Recovery word \d+$/).all()) {
    const id = await field.getAttribute("id");
    const label = await page.locator(`label[for="${id}"]`).innerText();
    const index = Number(label.match(/\d+/)![0]) - 1;
    await field.fill(words[index]);
  }
  words.fill("");
  await page.getByRole("button", { name: "Verify and open wallet" }).click();
  await expect(
    page.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
  for (const route of ["/import", "/create"]) {
    await walletRoute(page, route);
    await expect(
      page.getByRole("heading", { name: "A wallet is already saved here" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Recovery phrase (12 or 24 English words)"),
    ).toHaveCount(0);
    await page
      .getByRole("link", { name: "Open existing wallet", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Your wallet", exact: true }),
    ).toBeVisible();
  }
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your wallet is locked" }),
  ).toBeVisible();
});
test("locked-screen reset, create and restore actions preserve the wallet until explicit confirmation", async ({
  page,
}) => {
  test.setTimeout(60000);
  await restore(page);
  await page.getByRole("button", { name: "Lock wallet", exact: true }).click();
  await page.getByLabel("Wallet password", { exact: true }).fill("short");
  await page
    .getByRole("button", { name: "Unlock wallet", exact: true })
    .click();
  await expect(
    page.getByText(
      "Unable to unlock. Check your password or encrypted backup.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByText("What if someone else uses the same password?", { exact: true })
    .click();
  await expect(
    page.getByText(
      /Two people choosing the same password still have different wallets/,
    ),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Create new wallet", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Reset and create new wallet",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("link", { name: "Cancel and keep saved wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your wallet is locked", exact: true }),
  ).toBeVisible();
  const confirmReset = async (name: string) => {
    const button = page.getByRole("button", { name, exact: true });
    await page
      .getByLabel("Type RESET WALLET to confirm", { exact: true })
      .fill("RESET WALLET");
    await expect(button).toBeDisabled();
    await page.getByRole("checkbox").check();
    await button.click();
  };
  await page
    .getByRole("link", { name: "Create new wallet", exact: true })
    .click();
  await confirmReset("Reset and create new wallet");
  await expect(
    page.getByRole("heading", { name: "Create wallet", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Wallet password", { exact: true }),
  ).toBeVisible();
  await restore(page);
  await page.getByRole("button", { name: "Lock wallet", exact: true }).click();
  await page.getByRole("link", { name: "Restore wallet", exact: true }).click();
  await confirmReset("Reset and restore wallet");
  await expect(
    page.getByLabel("Recovery phrase (12 or 24 English words)", {
      exact: true,
    }),
  ).toBeVisible();
  await restore(page);
  await page
    .getByRole("button", { name: "Manage accounts", exact: true })
    .click();
  await expect(
    page.locator("code").filter({ hasText: vectors.accounts[0].address }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Lock wallet", exact: true }).click();
  await page.getByRole("link", { name: "Reset wallet", exact: true }).click();
  await confirmReset("Reset wallet");
  await expect(
    page.getByRole("link", { name: "Create wallet", exact: true }),
  ).toBeVisible();
});
test("published-vector recovery, encrypted export/restore, password changes, storage and cross-tab lock", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const observed: string[] = [];
  const consoleMessages: string[] = [];
  page.on("request", (r) => {
    const data = r.postData();
    if (data) observed.push(data);
  });
  page.on("console", (m) => consoleMessages.push(m.text()));
  await restore(page);
  await expect(
    page.getByRole("button", { name: "Lock wallet", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent =
      "document.documentElement.dataset.inlineCspProbe='executed'";
    document.head.append(script);
  });
  expect(
    await page.evaluate(() => document.documentElement.dataset.inlineCspProbe),
  ).toBeUndefined();
  await page.getByRole("button", { name: "Manage accounts" }).click();
  await expect(
    page.locator("code").filter({ hasText: vectors.accounts[0].address }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await settings(page);
  await page
    .getByLabel("Current wallet password", { exact: true })
    .fill(password);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export encrypted backup", exact: true })
    .click();
  const file = await download;
  let backup = "";
  for await (const b of (await file.createReadStream())!)
    backup += b.toString();
  expect(backup.includes(vectors.mnemonic)).toBe(false);
  await page
    .getByLabel("Current wallet password", { exact: true })
    .fill(password);
  await page
    .getByLabel("New wallet password", { exact: true })
    .fill(nextPassword);
  await page
    .getByLabel("Confirm new wallet password", { exact: true })
    .fill(nextPassword);
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(
    page.getByText("Password changed and encrypted storage verified."),
  ).toBeVisible();
  const another = await context.newPage();
  await another.goto("/");
  await expect(
    another.getByRole("heading", { name: "Your wallet is locked" }),
  ).toBeVisible();
  await another
    .getByLabel("Wallet password", { exact: true })
    .fill(nextPassword);
  await another
    .getByRole("button", { name: "Unlock wallet", exact: true })
    .click();
  await expect(
    another.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Lock wallet", exact: true })
    .first()
    .click();
  await expect(
    another.getByRole("heading", { name: "Your wallet is locked" }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Wallet password", { exact: true }).fill(nextPassword);
  await page
    .getByRole("button", { name: "Unlock wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
  const storage = await page.evaluate(async () => {
    const request = indexedDB.open("ewallet-v1-local", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const publicData: unknown[] = [];
    for (const name of Array.from(db.objectStoreNames)) {
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const get = db.transaction(name).objectStore(name).getAll();
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      publicData.push({ store: name, values });
    }
    db.close();
    return JSON.stringify(publicData);
  });
  for (const value of [vectors.mnemonic, password, nextPassword]) {
    expect(storage.includes(value)).toBe(false);
    expect(observed.some((p) => p.includes(value))).toBe(false);
    expect(consoleMessages.some((p) => p.includes(value))).toBe(false);
  }
  const fresh = await context.browser()!.newContext({ acceptDownloads: true });
  try {
    const restored = await fresh.newPage();
    await restored.goto("/import");
    await restored
      .getByRole("button", { name: "Encrypted backup", exact: true })
      .click();
    await restored.getByLabel("Encrypted backup file").setInputFiles({
      name: "encrypted.json",
      mimeType: "application/json",
      buffer: Buffer.from(backup),
    });
    await restored
      .getByLabel("Backup password", { exact: true })
      .fill(password);
    await restored.getByRole("checkbox").check();
    await restored
      .getByRole("button", { name: "Restore wallet", exact: true })
      .click();
    await expect(
      restored.getByRole("heading", { name: "Your wallet", exact: true }),
    ).toBeVisible();
    await restored.getByRole("button", { name: "Manage accounts" }).click();
    await expect(
      restored.locator("code").filter({ hasText: vectors.accounts[0].address }),
    ).toBeVisible();
  } finally {
    await fresh.close();
  }
  await mkdir(".local/reports/core", { recursive: true });
  await writeFile(
    ".local/reports/core/browser-security.json",
    JSON.stringify(
      {
        secretNetworkLeaks: 0,
        secretConsoleLeaks: 0,
        plaintextSecretStorage: 0,
        crossTabLock: "passed",
        separateTabUnlock: "passed",
        encryptedBackupRestore: "passed",
        passwordChangeRestart: "passed",
        screenshots: "disabled",
        trace: "disabled",
        video: "disabled",
      },
      null,
      2,
    ),
  );
});
