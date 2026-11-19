import { test, type Page } from "@playwright/test";
import { expect } from "../helpers/private-expect";
import { readFile, writeFile } from "node:fs/promises";
import {
  JsonRpcProvider,
  verifyMessage,
  verifyTypedData,
  parseEther,
} from "ethers";
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
const password = "Public local test-only password";
const manifest = JSON.parse(
  await readFile(".local/state/seed/evm-manifest.json", "utf8"),
);
async function unlock(popup: Page) {
  await popup.getByLabel("Wallet password", { exact: true }).fill(password);
  await popup
    .getByRole("button", { name: "Unlock approval window", exact: true })
    .click();
  await expect(
    popup.getByText("Selected signing account", { exact: true }),
  ).toBeVisible();
}
async function popupFrom(page: Page, name: string) {
  const event = page.waitForEvent("popup");
  await page.getByRole("button", { name, exact: true }).click();
  const popup = await event;
  await unlock(popup);
  await expect(popup.getByTestId("request-origin")).toContainText(
    "http://127.0.0.1:5174",
  );
  return popup;
}
test("built cross-origin popup connects, signs messages, sends a payment and revokes its live session", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  const provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, {
      staticNetwork: true,
      cacheTimeout: 0,
    }),
    snapshot = await provider.send("evm_snapshot", []);
  try {
    const fixture = JSON.parse(
      await readFile(".local/secrets/alice.json", "utf8"),
    );
    await page.goto("/import");
    await page
      .getByLabel("Recovery phrase (12 or 24 English words)")
      .fill(fixture.mnemonic);
    await page
      .getByLabel("New wallet password", { exact: true })
      .fill(password);
    await page.getByLabel("Confirm new wallet password").fill(password);
    await page
      .getByRole("button", { name: "Restore wallet", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Your wallet", exact: true }),
    ).toBeVisible();
    const dapp = await context.newPage();
    await dapp.goto("http://127.0.0.1:5174");
    const connection = await popupFrom(dapp, "Connect evm");
    await connection
      .getByRole("button", { name: "Approve connection", exact: true })
      .click();
    await expect(dapp.getByTestId("accounts")).toContainText(
      manifest.identities.alice.evm.address,
    );
    // Replies from the dapp window itself have the wrong source and origin.
    await dapp.evaluate(() =>
      window.postMessage(
        {
          type: "ewallet:result",
          version: 1,
          channel: "0".repeat(64),
          requestId: crypto.randomUUID(),
          result: { accounts: ["attacker"], networkId: "eip155:1" },
        },
        location.origin,
      ),
    );
    await expect(dapp.getByTestId("accounts")).toContainText(
      manifest.identities.alice.evm.address,
    );
    const signing = await popupFrom(dapp, "Sign message");
    await signing
      .getByRole("button", { name: "Review request", exact: true })
      .click();
    await expect(signing.getByTestId("message-review")).toContainText(
      "Hello from the e-wallet reference dapp.",
    );
    await signing
      .getByRole("button", { name: "Approve signature", exact: true })
      .click();
    await expect(dapp.getByTestId("result")).toContainText("0x");
    const signature = JSON.parse(
      (await dapp.getByTestId("result").textContent())!,
    );
    expect(
      verifyMessage("Hello from the e-wallet reference dapp.", signature),
    ).toBe(manifest.identities.alice.evm.address);
    const typed = await popupFrom(dapp, "Sign typed message");
    await typed
      .getByRole("button", { name: "Review request", exact: true })
      .click();
    await expect(typed.getByTestId("message-review")).toContainText(
      "Reference dapp",
    );
    await typed
      .getByRole("button", { name: "Approve signature", exact: true })
      .click();
    await expect(dapp.getByTestId("result")).toContainText("0x");
    const typedSignature = JSON.parse(
      (await dapp.getByTestId("result").textContent())!,
    );
    expect(
      verifyTypedData(
        { name: "Reference dapp", version: "1", chainId: 31337 },
        { Message: [{ name: "text", type: "string" }] },
        { text: "Hello from the e-wallet reference dapp." },
        typedSignature,
      ),
    ).toBe(manifest.identities.alice.evm.address);
    const bob = manifest.identities.bob.evm.address,
      before = await provider.getBalance(bob);
    await dapp.getByLabel("Recipient", { exact: true }).fill(bob);
    const payment = await popupFrom(dapp, "Send 0.001 ETH");
    await payment
      .getByRole("button", { name: "Review request", exact: true })
      .click();
    await expect(
      payment.getByText("1000000000000000", { exact: true }),
    ).toBeVisible();
    await payment
      .getByRole("button", { name: "Approve operation", exact: true })
      .click();
    await expect(dapp.getByTestId("result")).toContainText("0x");
    const txHash = JSON.parse(
      (await dapp.getByTestId("result").textContent())!,
    );
    await expect
      .poll(() => provider.getBalance(bob))
      .toBe(before + parseEther("0.001"));
    expect((await provider.getTransactionReceipt(txHash))?.status).toBe(1);
    const rejected = await popupFrom(dapp, "Sign message");
    await rejected
      .getByRole("button", { name: "Reject request", exact: true })
      .click();
    await expect(dapp.getByTestId("result")).toContainText("Rejected (4001)");
    await dapp
      .getByRole("button", { name: "Unknown method", exact: true })
      .click();
    await expect(dapp.getByTestId("result")).toContainText("Rejected (4200)");
    const wrong = await popupFrom(dapp, "Wrong network");
    await wrong
      .getByRole("button", { name: "Review request", exact: true })
      .click();
    await expect(
      wrong.getByText(
        "The requested sender or chain differs from the selected account.",
        { exact: true },
      ),
    ).toBeVisible();
    await wrong
      .getByRole("button", { name: "Reject request", exact: true })
      .click();
    await page.locator('a[href="/apps"]').first().click();
    await expect(
      page.getByText("http://127.0.0.1:5174", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(dapp.getByTestId("accounts")).toContainText("None shared");
    await writeFile(
      ".local/reports/integration/dapp-evm-proof.json",
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          walletOrigin: "http://127.0.0.1:8787",
          dappOrigin: "http://127.0.0.1:5174",
          actualPopup: true,
          connection: true,
          personalSignatureRecovered: true,
          typedSignatureRecovered: true,
          transactionHash: txHash,
          receiptStatus: 1,
          userRejection: true,
          unknownMethodRejected: true,
          wrongNetworkRejected: true,
          foreignSourceIgnored: true,
          disconnectEvent: true,
          trace: false,
          screenshots: false,
        },
        null,
        2,
      ),
    );
    await connection.close();
  } finally {
    expect(await provider.send("evm_revert", [snapshot])).toBe(true);
    provider.destroy();
  }
});
test("reference diagnostics refuse wrong channel, target origin and payload reuse before signing", async ({
  page,
}) => {
  test.setTimeout(30000);
  await page.goto("http://127.0.0.1:5174");
  for (const [name, expected] of [
    ["Wrong channel probe", '"ignored": true'],
    ["Wrong target origin probe", '"ignored": true'],
    ["Tamper active request", '"rejected": true'],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByTestId("result")).toContainText(expected, {
      timeout: 10000,
    });
  }
});
