import { expect } from "../helpers/private-expect";
import { test, type Page } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import vectors from "../../fixtures/derivation-vectors.json" with { type: "json" };
const password = "Public vector-only test password",
  nextPassword = "Changed vector-only test password";
async function restore(page: Page) {
  await page.goto("/import");
  await page
    .getByLabel("Recovery phrase (12 or 24 English words)")
    .fill(vectors.mnemonic);
  await page.getByLabel("New wallet password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new wallet password").fill(password);
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
  await page.getByLabel("Confirm wallet password").fill(password);
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
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your wallet is locked" }),
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
  await expect(page.getByRole('button',{name:'Lock wallet',exact:true})).toBeVisible();
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
  await page.getByLabel("Current wallet password").fill(password);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export encrypted backup", exact: true })
    .click();
  const file = await download;
  let backup = "";
  for await (const b of (await file.createReadStream())!)
    backup += b.toString();
  expect(backup.includes(vectors.mnemonic)).toBe(false);
  await page.getByLabel("Current wallet password").fill(password);
  await page
    .getByLabel("New wallet password", { exact: true })
    .fill(nextPassword);
  await page.getByLabel("Confirm new wallet password").fill(nextPassword);
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
  await another.getByLabel("Wallet password").fill(nextPassword);
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
  await page.getByLabel("Wallet password").fill(nextPassword);
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
    await restored.getByLabel("Backup password").fill(password);
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
