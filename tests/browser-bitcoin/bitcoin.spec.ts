import { test, type Page } from "@playwright/test";
import { expect } from "../helpers/private-expect";
import { readFile, writeFile } from "node:fs/promises";
import {
  bitcoinRpc,
  bitcoinIdentity,
} from "../../services/backend/src/bitcoin-rpc";
import { satoshis, bitcoin } from "@ewallet/chain-bitcoin";
process.env.EWALLET_ISOLATED_BITCOIN_TEST = "1";
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
const manifest = JSON.parse(
  await readFile("artifacts/phase-03/isolated-bitcoin-manifest.json", "utf8"),
);
async function enableWatch(page: Page) {
  await expect
    .poll(
      async () =>
        (await page
          .getByRole("heading", {
            name: "Enable watch-only discovery",
            exact: true,
          })
          .count()) > 0,
    )
    .toBe(true);
  await page
    .getByLabel(
      "I understand that public descriptors reveal this account’s address activity.",
    )
    .check();
  await page
    .getByRole("button", {
      name: "Enable public descriptor watch",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("link", { name: "Send", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  try {
    await expect
      .poll(
        async () =>
          await page
            .getByRole("heading", {
              name: "Enable watch-only discovery",
              exact: true,
            })
            .count(),
        { timeout: 30000 },
      )
      .toBe(0);
  } catch (error) {
    throw new Error(
      "Watch setup: " +
        (await page.getByRole("alert").allTextContents()).join(" | "),
      { cause: error },
    );
  }
}
test("browser Worker sends P2WPKH and key-path P2TR PSBTs, recognizes internal change and confirms after CLI mining", async ({
  page,
}) => {
  test.setTimeout(180000);
  await bitcoinIdentity();
  const fixture = JSON.parse(
    await readFile(".local/secrets/alice.json", "utf8"),
  );
  await page.goto("/import");
  await page
    .getByLabel("Recovery phrase (12 or 24 English words)")
    .fill(fixture.mnemonic);
  await page
    .getByLabel("New wallet password", { exact: true })
    .fill("Public local test-only password");
  await page
    .getByLabel("Confirm new wallet password")
    .fill("Public local test-only password");
  await page
    .getByRole("button", { name: "Restore wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Selected network", exact: true })
    .selectOption("bitcoin:regtest");
  await enableWatch(page);
  const bob = manifest.finalBalances.find(
      (b: { name: string; purpose: number }) =>
        b.name === "bob" && b.purpose === 84,
    ).address,
    proofs = [];
  for (const purpose of [84, 86]) {
    if (purpose === 86) {
      await page.locator('a[href="/"]').first().click();
      await page
        .getByRole("button", { name: "Manage accounts", exact: true })
        .click();
      await page.getByRole("button", { name: /Bitcoin Taproot/ }).click();
      await enableWatch(page);
    }
    const mempoolBefore = (await bitcoinRpc("getrawmempool")) as string[];
    await page.getByRole("link", { name: "Send", exact: true }).click();
    await page.getByLabel("Recipient address", { exact: true }).fill(bob);
    await page.getByLabel("Amount (BTC)", { exact: true }).fill("0.01");
    await page
      .getByRole("button", { name: "Review payment", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Review operation" });
    await expect(dialog).toBeVisible({ timeout: 20000 });
    await expect(dialog).toContainText("internal change");
    await expect(dialog).toContainText(purpose === 84 ? "P2WPKH" : "P2TR");
    await dialog
      .getByRole("button", { name: "Approve operation", exact: true })
      .click();
    await expect(dialog).not.toBeVisible({ timeout: 20000 });
    await expect
      .poll(
        async () =>
          ((await bitcoinRpc("getrawmempool")) as string[]).filter(
            (txid) => !mempoolBefore.includes(txid),
          ).length,
      )
      .toBe(1);
    const txid = ((await bitcoinRpc("getrawmempool")) as string[]).find(
      (txid) => !mempoolBefore.includes(txid),
    )!;
    const transaction = (await bitcoinRpc("getrawtransaction", [
      txid,
      true,
    ])) as {
      hex: string;
      vsize: string;
      vout: Array<{ value: string; scriptPubKey: { address?: string } }>;
    };
    expect(
      transaction.vout.some(
        (o) =>
          o.scriptPubKey.address === bob && satoshis(o.value) === "1000000",
      ),
    ).toBe(true);
    const decoded = bitcoin.Transaction.fromHex(transaction.hex);
    expect(decoded.ins[0].witness.length).toBe(purpose === 84 ? 2 : 1);
    expect(decoded.outs.length).toBe(2);
    const miner = await bitcoinRpc(
      "getnewaddress",
      ["browser-test", "bech32"],
      "ewallet-miner",
    );
    await bitcoinRpc("generatetoaddress", [6, miner]);
    await page.locator('a[href="/activity"]').first().click();
    await expect
      .poll(
        async () =>
          (await page.locator(".activity-row").first().textContent())?.includes(
            "confirmed",
          ),
        { timeout: 20000 },
      )
      .toBe(true);
    proofs.push({
      purpose,
      txid,
      vsize: transaction.vsize,
      recipientDelta: "1000000",
      internalChange: true,
      confirmedBlocks: 6,
      witnessElements: decoded.ins[0].witness.length,
    });
  }
  const info = (await bitcoinRpc("getwalletinfo", [], "ewallet-watch")) as {
    private_keys_enabled: boolean;
  };
  expect(info.private_keys_enabled).toBe(false);
  await writeFile(
    "artifacts/phase-03/bitcoin-browser-proof.json",
    JSON.stringify(
      {
        source: "node",
        networkId: "bitcoin:regtest",
        genesisHash: manifest.genesisHash,
        fundingEpoch: manifest.fundingEpoch,
        isolatedNode: true,
        watchWalletPrivateKeysEnabled: false,
        signingBoundary: "Browser Dedicated Worker",
        proofs,
      },
      null,
      2,
    ),
  );
});
