import { test, type Page } from "@playwright/test";
import { expect } from "../helpers/private-expect";
import { readFile, writeFile } from "node:fs/promises";
import { bitcoin } from "@ewallet/chain-bitcoin";
import { bitcoinRpc } from "../../services/backend/src/bitcoin-rpc";
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
process.env.EWALLET_ISOLATED_BITCOIN_TEST = "1";
const password = "Public local test-only password";
async function popup(page: Page, name: string) {
  const event = page.waitForEvent("popup");
  await page.getByRole("button", { name, exact: true }).click();
  const p = await event;
  await p.getByLabel("Wallet password", { exact: true }).fill(password);
  await p
    .getByRole("button", { name: "Unlock approval window", exact: true })
    .click();
  return p;
}
test("Bitcoin project API connects with descriptor consent, reviews a PSBT and broadcasts only its exact prior authorization", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  const fixture = JSON.parse(
    await readFile(".local/secrets/alice.json", "utf8"),
  );
  await page.goto("/import");
  await page
    .getByLabel("Recovery phrase (12 or 24 English words)")
    .fill(fixture.mnemonic);
  await page.getByLabel("New wallet password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new wallet password").fill(password);
  await page
    .getByRole("button", { name: "Restore wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
  const dapp = await context.newPage();
  await dapp.goto("http://127.0.0.1:5174");
  await dapp.getByRole("button", { name: "BITCOIN", exact: true }).click();
  const connection = await popup(dapp, "Connect bitcoin");
  await connection
    .getByLabel("Approval network")
    .selectOption("bitcoin:regtest");
  await connection.getByRole("checkbox").check();
  await connection
    .getByRole("button", { name: "Approve connection", exact: true })
    .click();
  await expect(dapp.getByTestId("accounts")).toContainText("bcrt1");
  await dapp
    .getByRole("button", {
      name: "Prepare 0.0001 BTC payment",
      exact: true,
    })
    .click();
  await expect(dapp.getByTestId("result")).toContainText("prepared");
  const unsigned = bitcoin.Psbt.fromBase64(
    await dapp
      .getByLabel("PSBT (base64) or signed transaction (hex)", { exact: true })
      .inputValue(),
    { network: bitcoin.networks.regtest },
  );
  const signing = await popup(dapp, "Sign PSBT");
  await signing.getByRole("checkbox").check();
  await signing
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect(signing.getByText("10000", { exact: true })).toBeVisible();
  await signing
    .getByRole("button", { name: "Approve operation", exact: true })
    .click();
  await expect(dapp.getByTestId("result")).toContainText("transaction");
  const signed = JSON.parse((await dapp.getByTestId("result").textContent())!);
  const tx = bitcoin.Transaction.fromHex(signed.transaction);
  expect(tx.getId()).toBe(signed.txid);
  expect(
    tx.outs.map((o) => [o.value, Buffer.from(o.script).toString("hex")]),
  ).toEqual(
    unsigned.txOutputs.map((o) => [
      o.value,
      Buffer.from(o.script).toString("hex"),
    ]),
  );
  expect(await bitcoinRpc("getrawmempool")).not.toContain(signed.txid);
  const broadcast = await popup(dapp, "Broadcast transaction");
  await broadcast.getByRole("checkbox").check();
  await broadcast
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect(
    broadcast.getByText(
      "No new signature is created. Broadcasting submits the exact previously approved transaction.",
      { exact: true },
    ),
  ).toBeVisible();
  await broadcast
    .getByRole("button", { name: "Approve operation", exact: true })
    .click();
  await expect(dapp.getByTestId("result")).toContainText(signed.txid);
  expect(await bitcoinRpc("getrawmempool")).toContain(signed.txid);
  await writeFile(
    ".local/reports/integration/dapp-bitcoin-proof.json",
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        actualPopup: true,
        descriptorConsent: true,
        signPsbt: true,
        outputsUnchanged: true,
        noBroadcastDuringSigning: true,
        txid: signed.txid,
        actualMempool: true,
        isolatedLedger: true,
      },
      null,
      2,
    ),
  );
  await connection.close();
});
