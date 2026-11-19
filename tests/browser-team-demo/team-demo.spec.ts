import { test, type Page } from "@playwright/test";
import { expect } from "../helpers/private-expect";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
test("two logins transfer credits; server roles, suspension and read-only audit work", async ({
  browser,
  page,
}) => {
  test.setTimeout(90000);
  const credentials: { username: string; password: string }[] = JSON.parse(
    await readFile(
      ".local/team-demo-browser/team-demo-credentials.json",
      "utf8",
    ),
  );
  const login = async (p: Page, username: string) => {
    await p.goto("/accounts");
    await p.getByRole("heading", { name: "Sign in to your account", exact: true }).waitFor();
    expect(await p.locator("body").innerText()).not.toMatch(/\bdemo\b|\bmock\b|\btest(?:net| assets| data| networks)?\b|\bclassroom\b|\bfixture\b/i);
    await p.getByLabel("Username", { exact: true }).fill(username);
    await p
      .getByLabel("Password", { exact: true })
      .fill(credentials.find((c) => c.username === username)!.password);
    await p.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(p.getByTestId("team-role")).toContainText(
      username === "alice" || username === "bob" ? "member" : username,
    );
    expect(await p.locator("body").innerText()).not.toMatch(/\bdemo\b|\bmock\b|\btest(?:net| assets| data| networks)?\b|\bclassroom\b|\bfixture\b/i);
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
    await expect(page.getByTestId("team-balance")).toContainText("1000.00");
    await expect(bob.getByTestId("team-balance")).toContainText("1000.00");
    await page
      .getByLabel("Recipient", { exact: true })
      .selectOption({ label: "Bob (@bob)" });
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
    await expect(page.getByTestId("team-balance")).toContainText("974.85");
    await bob.getByRole("button", { name: "Refresh balances" }).click();
    await expect(bob.getByTestId("team-balance")).toContainText("1025.15");
    await expect(bob.getByText("Alice → Bob", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Check admin permission" }).click();
    await expect(
      page.getByText(
        "Server returned 403: Member access to admin reports is blocked.",
      ),
    ).toBeVisible();
    await mkdir("artifacts/product", { recursive: true });
    await page.screenshot({
      path: "artifacts/product/team-demo-alice.png",
      fullPage: true,
    });
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
    await expect(page.getByTestId("team-balance")).toContainText("974.85");
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
    await admin.screenshot({
      path: "artifacts/product/team-demo-auditor.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "artifacts/product/team-demo-mobile.png",
      fullPage: true,
    });
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
      "artifacts/product/team-demo-browser.json",
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
          screenshots: [
            "team-demo-alice.png",
            "team-demo-auditor.png",
            "team-demo-mobile.png",
          ],
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
