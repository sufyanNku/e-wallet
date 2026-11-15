import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
const root = "artifacts/phase-01";
async function sample(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore sample wallet" }).click();
  await expect(
    page.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
}
async function route(page: Page, path: string) {
  await page.evaluate((path) => {
    history.pushState({}, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}
test("keyboard onboarding, approval rejection and payment receipt", async ({
  page,
}) => {
  await page.goto("/create");
  await page.getByLabel("Sample password", { exact: true }).focus();
  await page.keyboard.type("only sample password");
  await page.keyboard.press("Tab");
  await page.keyboard.type("only sample password");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Back up the sample words" }),
  ).toBeVisible();
  await page.getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  for (const field of await page.getByLabel(/^Sample word \d+$/).all()) {
    const n =
      (await field.getAttribute("aria-label")) ??
      (await page
        .locator(`label[for="${await field.getAttribute("id")}"]`)
        .innerText());
    const index = Number(n.match(/\d+/)![0]);
    await field.focus();
    await page.keyboard.type(`sample${String(index).padStart(2, "0")}`);
  }
  await page.getByRole("button", { name: "Open sample wallet" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Send", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByLabel("Recipient address", { exact: true })
    .fill("0x2222222222222222222222222222222222222222");
  await page.getByLabel("Amount (ETH)", { exact: true }).fill("0.1");
  await page.getByRole("button", { name: "Review payment" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("0x2222222222222222222222222222222222222222", {
      exact: true,
    }),
  ).toBeVisible();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await dialog.getByRole("button", { name: "Reject", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Review payment" }).click();
  await dialog
    .getByRole("button", { name: "Approve sample operation" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Activity", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /send.*confirmed/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /send.*confirmed/i }).click();
  await expect(
    page.getByRole("heading", { name: "Transaction details" }),
  ).toBeVisible();
});
test("all screens at 320, 360, tablet and desktop have no horizontal clipping", async ({
  page,
}) => {
  test.setTimeout(120000);
  await mkdir(root, { recursive: true });
  await sample(page);
  const paths = [
    "/",
    "/asset?key=eip155%3A31337%2Fnative%2Fnative%2F",
    "/tokens",
    "/send",
    "/receive",
    "/contacts",
    "/activity",
    "/collectibles",
    "/apps",
    "/connect",
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
      await route(page, path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${path} at ${width}`,
      ).toBe(true);
      await page.screenshot({
        path: `${root}/${width}-${path === "/" ? "home" : path.slice(1).split('?')[0]}.png`,
        fullPage: true,
      });
    }
  }
  for (const width of [320,360,768,1440]) {
    await page.setViewportSize({width,height:900});
    for (const path of ['/welcome','/create','/import','/unlock']) {
      await route(page,path);
      await page.getByRole('heading',{level:1}).waitFor();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:`${root}/${width}-${path.slice(1)}.png`,fullPage:true});
    }
  }
});
test("built nested route, approval window and accessibility", async ({
  page,
}) => {
  await page.goto("/send");
  await expect(
    page.getByRole("heading", { name: /A little closer/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Explore sample wallet" }).click();
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
    await route(page, path);
    await page.getByRole("heading", { level: 1 }).waitFor();
    const r = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    results.push({ path, violations: r.violations });
    expect(r.violations, `Accessibility on ${path}`).toEqual([]);
  }
  await page.setViewportSize({ width: 460, height: 720 });
  await route(page, "/connect");
  await page.getByRole("button", { name: "Reject connection" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Connection rejected. No account was shared."),
  ).toBeVisible();
  await page.screenshot({
    path: `${root}/approval-460x720.png`,
    fullPage: true,
  });
  await writeFile(
    `${root}/accessibility.json`,
    JSON.stringify(results, null, 2),
  );
});
test("receive QR payload roundtrip and exact custom token import", async ({
  page,
}) => {
  await sample(page);
  await route(page, "/receive");
  await expect(
    page.getByAltText("QR code of the reviewed sample receive request"),
  ).toBeVisible();
  await page.getByAltText('QR code of the reviewed sample receive request').screenshot({path:`${root}/sample-qr.png`});
  await route(page, "/send");
  await page.getByLabel('Upload QR image').setInputFiles(`${root}/sample-qr.png`);
  await expect(page.getByLabel('Recipient address',{exact:true})).toHaveValue('0x1111111111111111111111111111111111111111');
  await page
    .getByLabel("QR or address text")
    .fill(
      JSON.stringify({
        address: "0x2222222222222222222222222222222222222222",
        network: "eip155:84532",
        amount: "1",
      }),
    );
  await page.getByRole("button", { name: "Read pasted request" }).click();
  await expect(page.getByRole("alert")).toContainText("another network");
  await route(page, "/tokens");
  await page
    .getByLabel("Contract or mint address")
    .fill("0x1212121212121212121212121212121212121212");
  await page.getByLabel("Sample symbol").fill("DEMO");
  await page.getByLabel("Decimals", { exact: true }).fill("6");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Import sample token" }).click();
  await expect(page.getByText("DEMO", { exact: true })).toBeVisible();
});
