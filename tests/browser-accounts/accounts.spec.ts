import { chooseOption } from "../helpers/select-option";
import { test, type Page } from "@playwright/test";
import { expect } from "../helpers/private-expect";
import { readFile, writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
test("two logins transfer credits; server roles, suspension and read-only audit work", async ({
  browser,
  page,
}) => {
  test.setTimeout(90000);
  const credentials: { username: string; password: string }[] = JSON.parse(
    await readFile(".local/accounts-browser/accounts-credentials.json", "utf8"),
  );
  const login = async (p: Page, username: string) => {
    await p.goto("/accounts");
    await p
      .getByRole("heading", { name: "Sign in to your account", exact: true })
      .waitFor();
    expect(await p.locator("body").innerText()).not.toMatch(
      /\bdemo\b|\bmock\b|\btest(?:net| assets| data| networks)?\b|\bclassroom\b|\buniversity\b|\bfixture\b/i,
    );
    await p.getByLabel("Username", { exact: true }).fill(username);
    await p
      .getByLabel("Password", { exact: true })
      .fill(credentials.find((c) => c.username === username)!.password);
    await p.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(p.getByTestId("account-role")).toContainText(
      username === "alice" || username === "bob" ? "member" : username,
    );
    expect(await p.locator("body").innerText()).not.toMatch(
      /\bdemo\b|\bmock\b|\btest(?:net| assets| data| networks)?\b|\bclassroom\b|\buniversity\b|\bfixture\b/i,
    );
  };
  const bobContext = await browser.newContext({
    baseURL: "http://127.0.0.1:8877",
  });
  const adminContext = await browser.newContext({
    baseURL: "http://127.0.0.1:8877",
  });
  try {
    const bob = await bobContext.newPage(),
      admin = await adminContext.newPage();
    await login(page, "alice");
    await login(bob, "bob");
    await expect(page.getByTestId("account-balance")).toContainText("1000.00");
    await expect(bob.getByTestId("account-balance")).toContainText("1000.00");
    await chooseOption(page.getByLabel("Recipient", { exact: true }), {
      label: "Bob (@bob)",
    });
    await page.getByLabel("Amount in credits").fill("25.15");
    await page
      .getByRole("button", { name: "Review transfer", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Confirm transfer" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Confirm transfer", exact: true })
      .click();
    await expect(page.getByText(/Transfer completed\. Receipt:/)).toBeVisible();
    await expect(page.getByTestId("account-balance")).toContainText("974.85");
    await bob.getByRole("button", { name: "Refresh balances" }).click();
    await expect(bob.getByTestId("account-balance")).toContainText("1025.15");
    await bob.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await bob.reload();
    await expect(bob.getByTestId("account-balance")).toContainText("1025.15");
    await expect(bob.getByText("Alice → Bob", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Check admin permission" }).click();
    await expect(
      page.getByText(
        "Server returned 403: Member access to admin reports is blocked.",
      ),
    ).toBeVisible();
    await login(admin, "admin");
    await expect(
      admin.getByRole("heading", { name: "Account oversight" }),
    ).toBeVisible();
    await admin
      .getByRole("button", { name: "Suspend Alice", exact: true })
      .click();
    await expect(
      admin.getByText("Alice suspended.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh balances" }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in to your account" }),
    ).toBeVisible();
    await admin
      .getByRole("button", { name: "Enable Alice", exact: true })
      .click();
    await expect(
      admin.getByText("Alice enabled.", { exact: true }),
    ).toBeVisible();
    await login(page, "alice");
    await expect(page.getByTestId("account-balance")).toContainText("974.85");
    await admin.getByRole("button", { name: "Sign out", exact: true }).click();
    await login(admin, "auditor");
    await expect(
      admin.getByRole("heading", { name: "Read-only access" }),
    ).toBeVisible();
    await expect(
      admin.getByRole("button", { name: "Suspend Alice", exact: true }),
    ).not.toBeVisible();
    await admin
      .getByRole("button", { name: "Check transfer permission" })
      .click();
    await expect(
      admin.getByText(
        "Server returned 403: Auditor transfers are blocked. No credits moved.",
      ),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      accessibility.violations.map((v) => ({ id: v.id, impact: v.impact })),
    ).toEqual([]);
    await writeFile(
      ".local/reports/product/accounts-browser.json",
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          source: "Actual browser and isolated SQLite database",
          twoIndependentLogins: true,
          transferAmount: "25.15",
          aliceBalance: "974.85",
          bobBalance: "1025.15",
          memberAdminDenied: 403,
          auditorTransferDenied: 403,
          suspendedSessionRevoked: true,
          reenablePreservedBalance: true,
          mobileWidth: 390,
          horizontalClipping: false,
          realFundsEnabled: false,
          testedWidths: [320, 390, 768, 1440],
          accessibilityViolations: accessibility.violations.length,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await bobContext.close();
    await adminContext.close();
  }
});

test("a new user chooses a username, signs out and signs back in with it", async ({
  page,
}) => {
  const username = "morgan_" + Date.now();
  const password = "New account browser password";
  await page.goto("/create");
  await page.getByLabel("Wallet password", { exact: true }).fill(password);
  await page
    .getByLabel("Confirm wallet password", { exact: true })
    .fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Back up your recovery phrase",
      exact: true,
    }),
  ).toBeVisible();
  // Generated recovery words never enter reports, screenshots, traces or logs.
  const words = await page
    .locator(".word-grid>div")
    .evaluateAll((elements) =>
      elements.map((el) => el.childNodes[1].textContent ?? ""),
    );
  expect(words.length).toBe(24);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel(/^Recovery word \d+$/).first()).toBeVisible();
  for (const field of await page.getByLabel(/^Recovery word \d+$/).all()) {
    const id = await field.getAttribute("id");
    const label = await page.locator(`label[for="${id}"]`).innerText();
    await field.fill(words[Number(label.match(/\d+/)![0]) - 1]);
  }
  words.fill("");
  await page.getByRole("button", { name: "Verify and open wallet" }).click();
  await expect
    .poll(() => page.url())
    .toMatch(/\/accounts\?mode=register&from=wallet$/);
  await expect(
    page.getByRole("heading", { name: "Create your account", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Your name", { exact: true }).fill("Morgan");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByLabel("Confirm account password", { exact: true })
    .fill(password);
  await page
    .getByRole("button", { name: "Show Password", exact: true })
    .click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    password,
  );
  await page
    .getByRole("button", { name: "Hide Password", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create account and sign in", exact: true })
    .click();
  await expect(page.getByTestId("account-role")).toContainText("member");
  await expect(page.getByTestId("account-balance")).toContainText("0.00");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("heading", { name: "Sign in to your account", exact: true })
    .waitFor();
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("account-role")).toContainText("member");
  await page
    .getByRole("link", { name: "Back to crypto wallet", exact: true })
    .click();
  // Account authentication never unlocks the separately encrypted signing vault.
  await expect(
    page.getByRole("heading", { name: "Your wallet is locked", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Wallet password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Unlock wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Your wallet is ready to receive", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sign out of wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your wallet is locked", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".toast[role=status]")).toContainText(
    "Signed out. Your wallet is locked.",
  );
  expect((await page.request.get("/api/v1/accounts/dashboard")).status()).toBe(
    401,
  );
  await page.goto("/accounts");
  await expect(
    page.getByRole("heading", { name: "Sign in to your account", exact: true }),
  ).toBeVisible();
});
