import { expect } from "../helpers/private-expect";
import { test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "lossless-json";
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
const manifest = JSON.parse(
    await readFile(".local/reports/chains/isolated-solana-manifest.json", "utf8"),
  ),
  alice = manifest.identities.alice.address,
  bob = manifest.identities.bob.address,
  dana = manifest.identities.dana.address;
async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch("http://127.0.0.1:18899", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const result = parse(await response.text()) as {
    result: unknown;
    error?: unknown;
  };
  if (result.error) throw new Error("Isolated test RPC failed: " + method);
  return result.result as Record<string, unknown>;
}
async function balance(address: string) {
  const response = await rpc("getBalance", [
    address,
    { commitment: "confirmed" },
  ]);
  return BigInt(String(response.value));
}
async function tokens(address: string, mint: string) {
  const result = await rpc("getTokenAccountsByOwner", [
    address,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  return (
    result.value as Array<{
      account: {
        data: { parsed: { info: { tokenAmount: { amount: string } } } };
      };
    }>
  ).reduce(
    (sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}
async function approve(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Review operation" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Approve operation", exact: true })
    .click();
  await expect(dialog).not.toBeVisible({ timeout: 15000 });
}
async function home(page: Page) {
  await page.locator('a[href="/"]').first().click();
}
async function send(
  page: Page,
  recipient: string,
  amount: string,
  symbol: string,
  standard = "native",
  mint = "native",
) {
  await home(page);
  await page.getByRole("link", { name: "Send", exact: true }).click();
  await page
    .getByLabel("Asset", { exact: true })
    .selectOption(`solana:local/${standard}/${mint}/`);
  await page.getByLabel("Recipient address", { exact: true }).fill(recipient);
  await page.getByLabel(`Amount (${symbol})`, { exact: true }).fill(amount);
  await page.getByRole("button", { name: "Review payment" }).click();
  await approve(page);
}
test("browser Worker signs SOL, SPL with missing ATA, Token-2022 and a standard Metaplex NFT, then revokes a real delegate", async ({
  page,
}) => {
  test.setTimeout(180000);
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
  ).toBeVisible({timeout:15000}).catch(async()=>{throw new Error("Restore did not open portfolio. Public errors: "+(await page.getByRole("alert").allTextContents()).join(" | "));});
  await page
    .getByRole("combobox", { name: "Selected network", exact: true })
    .selectOption("solana:local");
  await expect(page.getByText("sEWLT", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  const nativeBefore = await balance(bob),
    aliceBefore = await balance(alice);
  await send(page, bob, "0.001", "SOL");
  await expect.poll(() => balance(bob)).toBe(nativeBefore + 1000000n);
  expect(await balance(alice)).toBeLessThan(aliceBefore - 1000000n);
  const tokenBefore = await tokens(dana, manifest.mints.sEWLT.address);
  await home(page);
  await page.getByRole("link", { name: "Send", exact: true }).click();
  await page
    .getByLabel("Asset", { exact: true })
    .selectOption(`solana:local/spl/${manifest.mints.sEWLT.address}/`);
  await page.getByLabel("Recipient address", { exact: true }).fill(dana);
  await page.getByLabel("Amount (sEWLT)", { exact: true }).fill("0.000000001");
  await page.getByRole("button", { name: "Review payment" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "associated token account",
  );
  await approve(page);
  await expect
    .poll(() => tokens(dana, manifest.mints.sEWLT.address))
    .toBe(tokenBefore + 1n);
  const t22Before = await tokens(dana, manifest.mints.token2022.address);
  await send(
    page,
    dana,
    "0.000001",
    "d2022",
    "token2022",
    manifest.mints.token2022.address,
  );
  await expect
    .poll(() => tokens(dana, manifest.mints.token2022.address))
    .toBe(t22Before + 1n);
  await page.locator('a[href="/collectibles"]').first().click();
  await page.getByRole("button", { name: /Access Pass #1/ }).click();
  await page.getByLabel("Full recipient address").fill(bob);
  await page
    .getByRole("button", { name: "Review collectible transfer" })
    .click();
  await approve(page);
  await expect.poll(() => tokens(bob, manifest.mints.nft1.address)).toBe(1n);
  await page.locator('a[href="/apps"]').first().click();
  await page
    .getByRole("button", { name: "Review revoke dUSDC", exact: true })
    .click();
  await approve(page);
  await expect
    .poll(async () => {
      const delegated = await rpc("getTokenAccountsByOwner", [
        alice,
        { mint: manifest.mints.dUSDC.address },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      const info = (
        delegated.value as Array<{
          account: { data: { parsed: { info: { delegate?: string } } } };
        }>
      )[0].account.data.parsed.info;
      return info.delegate === undefined;
    })
    .toBe(true);
  for (const [key, label, standard] of [
    ["frozen", "dICE", "spl"],
    ["unsupported", "dNO", "token2022"],
  ]) {
    await home(page);
    await page.getByRole("link", { name: "Send", exact: true }).click();
    await page
      .getByLabel("Asset", { exact: true })
      .selectOption(`solana:local/${standard}/${manifest.mints[key].address}/`);
    await page.getByLabel("Recipient address", { exact: true }).fill(dana);
    await page
      .getByLabel(`Amount (${label})`, { exact: true })
      .fill("0.000001");
    await page.getByRole("button", { name: "Review payment" }).click();
    await expect
      .poll(async () =>
        (await page.getByRole("alert").allTextContents())
          .join(" ")
          .includes(key === "frozen" ? "frozen" : "extensions"),
      )
      .toBe(true);
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  const signatures = await rpc("getSignaturesForAddress", [
    alice,
    { limit: 30, commitment: "confirmed" },
  ]);
  const receipts = [];
  for (const entry of signatures as unknown as Array<{ signature: string }>) {
    if (
      Object.values(manifest.stages).some(
        (s) => (s as { signature: string }).signature === entry.signature,
      )
    )
      continue;
    const transaction = await rpc("getTransaction", [
      entry.signature,
      {
        encoding: "json",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (transaction)
      receipts.push({
        signature: entry.signature,
        slot: String(transaction.slot),
        fee: String((transaction.meta as { fee: unknown }).fee),
        err: (transaction.meta as { err: unknown }).err,
      });
  }
  expect(receipts.length).toBeGreaterThanOrEqual(5);
  await writeFile(
    ".local/reports/chains/solana-browser-proof.json",
    JSON.stringify(
      {
        source: "node",
        networkId: "solana:local",
        genesisHash: manifest.genesisHash,
        isolatedValidator: true,
        nativeRecipientDelta: "1000000",
        splRecipientDelta: "1",
        token2022RecipientDelta: "1",
        nftOwner: bob,
        delegateRevoked: true,
        frozenAndUnsupportedToken2022Blocked: true,
        receipts,
        signingBoundary: "Browser Dedicated Worker; Kit 8 messages",
        recording: "Screenshots, traces, videos and page snapshots disabled",
      },
      null,
      2,
    ),
  );
});
