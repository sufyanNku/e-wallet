import { test, type Page } from "@playwright/test";
import { expect } from "../helpers/private-expect";
import { readFile, writeFile } from "node:fs/promises";
import { getTransactionDecoder } from "@solana/kit";
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
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
async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch("http://127.0.0.1:18899", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error("RPC failed: " + method);
  return body.result;
}
test("Wallet Standard connects through a real popup, signs exact bytes and sends a decoded Solana transfer", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  const fixture = JSON.parse(
      await readFile(".local/secrets/alice.json", "utf8"),
    ),
    manifest = JSON.parse(
      await readFile(
        "artifacts/phase-03/isolated-solana-manifest.json",
        "utf8",
      ),
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
  await dapp.getByRole("button", { name: "SOLANA", exact: true }).click();
  const connection = await popup(dapp, "Connect solana");
  await connection.getByLabel("Approval network").selectOption("solana:local");
  await expect(
    connection.getByText("Selected signing account", { exact: true }),
  ).toBeVisible();
  await connection
    .getByRole("button", { name: "Approve connection", exact: true })
    .click();
  await expect(dapp.getByTestId("accounts")).toContainText(
    manifest.identities.alice.address,
  );
  const sign = await popup(dapp, "Sign message");
  await sign
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect(sign.getByTestId("message-review")).toContainText(
    "Hello from the e-wallet reference dapp.",
  );
  await sign
    .getByRole("button", { name: "Approve signature", exact: true })
    .click();
  await expect(dapp.getByTestId("result")).toContainText("signature");
  const signedMessage = JSON.parse(
    (await dapp.getByTestId("result").textContent())!,
  );
  expect(Object.keys(signedMessage[0].signature)).toHaveLength(64);
  await dapp
    .getByLabel("Solana recipient", { exact: true })
    .fill(manifest.identities.bob.address);
  await dapp
    .getByRole("button", { name: "Prepare 0.00001 SOL transfer", exact: true })
    .click();
  await expect(dapp.getByTestId("result")).toContainText("prepared");
  const unsigned = await dapp
    .getByLabel("Unsigned transaction (base64)", { exact: true })
    .inputValue();
  const signing = await popup(dapp, "Sign transaction");
  await signing
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect(signing.getByText("10000", { exact: true })).toBeVisible();
  await signing
    .getByRole("button", { name: "Approve operation", exact: true })
    .click();
  await expect(dapp.getByTestId("result")).toContainText("signedTransaction");
  const signed = JSON.parse((await dapp.getByTestId("result").textContent())!);
  expect(
    getTransactionDecoder().decode(
      Buffer.from(signed.signedTransaction, "base64"),
    ).messageBytes,
  ).toEqual(
    getTransactionDecoder().decode(Buffer.from(unsigned, "base64"))
      .messageBytes,
  );
  // A new user action prepares a new transaction; the prior signed message is never rewritten.
  await dapp
    .getByRole("button", { name: "Prepare 0.00001 SOL transfer", exact: true })
    .click();
  await expect(dapp.getByTestId("result")).toContainText("prepared");
  const before = (
    await rpc("getBalance", [
      manifest.identities.bob.address,
      { commitment: "confirmed" },
    ])
  ).value;
  const payment = await popup(dapp, "Sign and send transaction");
  await payment
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await payment
    .getByRole("button", { name: "Approve operation", exact: true })
    .click();
  await expect(dapp.getByTestId("result")).toContainText("hash");
  const sent = JSON.parse((await dapp.getByTestId("result").textContent())!);
  await expect
    .poll(
      async () =>
        (
          await rpc("getBalance", [
            manifest.identities.bob.address,
            { commitment: "confirmed" },
          ])
        ).value,
    )
    .toBe(before + 10000);
  await writeFile(
    "artifacts/phase-04/dapp-solana-proof.json",
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        actualPopup: true,
        walletStandard: true,
        signMessage: true,
        signedExactTransaction: true,
        signature: sent.hash,
        recipientDeltaLamports: "10000",
        isolatedLedger: true,
      },
      null,
      2,
    ),
  );
  await connection.close();
});
