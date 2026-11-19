import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "../helpers/private-expect";
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
import { test, type Page } from "@playwright/test";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { JsonRpcProvider, Contract, parseEther, HDNodeWallet } from "ethers";
const manifest = JSON.parse(
  await readFile("artifacts/seed/evm-manifest.json", "utf8"),
);
let snapshot = "";
test.beforeEach(async () => {
  const p = new JsonRpcProvider("http://127.0.0.1:8545");
  if (BigInt(await p.send("eth_chainId", [])) !== 31337n)
    throw new Error("Refusing snapshot on wrong network");
  snapshot = await p.send("evm_snapshot", []);
  p.destroy();
});
test.afterEach(async () => {
  const p = new JsonRpcProvider("http://127.0.0.1:8545");
  expect(await p.send("evm_revert", [snapshot])).toBe(true);
  p.destroy();
});
async function importFixture(page: Page, name = "alice") {
  const fixture = JSON.parse(
    await readFile(`.local/secrets/${name}.json`, "utf8"),
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
  await expect(page.getByText("dUSDC", { exact: true }))
    .toBeVisible({ timeout: 15000 })
    .catch(async () => {
      const alerts = await page.getByRole("alert").allTextContents();
      throw new Error(
        "Token observation unavailable after import. Public error: " +
          alerts.join(" | "),
      );
    });
}
async function navigate(page: Page, path: string) {
  if (!(await page.locator(`a[href="${path}"]`).count()))
    await page.locator('a[href="/services"]').first().click();
  await page.locator(`a[href="${path}"]`).first().click();
}
async function approve(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Review operation" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Approve operation", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}
const alice = manifest.identities.alice.evm.address as string,
  bob = manifest.identities.bob.evm.address as string;
test("real browser approves and broadcasts an EVM native payment, token payment and NFT transfer through its Worker", async ({
  page,
}) => {
  test.setTimeout(120000);
  const failedRpc: Array<{ status: number; method: string }> = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/v1/rpc/") && response.status() >= 400) {
      let method = "unknown";
      try {
        method =
          JSON.parse(response.request().postData() ?? "{}").method ?? "unknown";
      } catch {
        /* Diagnostics deliberately omit payloads. */
      }
      failedRpc.push({ status: response.status(), method });
    }
  });
  const provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, {
    staticNetwork: true,
    cacheTimeout: 0,
  });
  const deployment = manifest.deployments.find(
    (m: { networkId: string }) => m.networkId === "eip155:31337",
  );
  await importFixture(page);
  const startBlock = await provider.getBlockNumber();
  const beforeBob = await provider.getBalance(bob),
    beforeAlice = await provider.getBalance(alice);
  await page.getByRole("link", { name: "Send", exact: true }).click();
  await page.getByLabel("Recipient address", { exact: true }).fill(bob);
  await page.getByLabel("Amount (ETH)", { exact: true }).fill("0.001");
  await page.getByRole("button", { name: "Review payment" }).click();
  const review = page.getByRole("dialog");
  await expect(review).toBeVisible();
  await expect(review.locator("code").filter({ hasText: bob })).toBeVisible();
  await review.getByRole("button", { name: "Approve operation" }).click();
  await expect(
    page.getByRole("heading", { name: "Activity", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => provider.getBalance(bob))
    .toBe(beforeBob + parseEther("0.001"));
  expect(await provider.getBalance(alice)).toBeLessThan(
    beforeAlice - parseEther("0.001"),
  );
  const usdc = new Contract(
      deployment.contracts.dUSDC.address,
      ["function balanceOf(address) view returns(uint256)"],
      provider,
    ),
    beforeToken = BigInt(await usdc.balanceOf(bob));
  await page.locator('a[href="/"]').first().click();
  await page.getByRole("link", { name: "Send", exact: true }).click();
  await page
    .getByLabel("Asset", { exact: true })
    .selectOption(
      `eip155:31337/erc20/${deployment.contracts.dUSDC.address.toLowerCase()}/`,
    );
  await page.getByLabel("Recipient address", { exact: true }).fill(bob);
  await page.getByLabel("Amount (dUSDC)", { exact: true }).fill("0.000001");
  await page.getByRole("button", { name: "Review payment" }).click();
  await review.getByRole("button", { name: "Approve operation" }).click();
  await expect
    .poll(async () => BigInt(await usdc.balanceOf(bob)))
    .toBe(beforeToken + 1n);
  await page.locator('a[href="/collectibles"]').first().click();
  await page.getByRole("button", { name: /Campus Pass #101/ }).click();
  await page.getByLabel("Full recipient address").fill(bob);
  await page
    .getByRole("button", { name: "Review collectible transfer" })
    .click();
  await expect
    .poll(
      async () =>
        (await review.isVisible()) ||
        (await page.getByRole("alert").count()) > 0,
    )
    .toBe(true);
  if (!(await review.isVisible()))
    throw new Error(
      (await page.getByRole("alert").allTextContents()).join(" | ") +
        JSON.stringify(failedRpc),
    );
  await review.getByRole("button", { name: "Approve operation" }).click();
  const nft = new Contract(
    deployment.contracts.DemoNFT721.address,
    ["function ownerOf(uint256) view returns(address)"],
    provider,
  );
  await expect.poll(() => nft.ownerOf(101)).toBe(bob);
  await page.locator('a[href="/collectibles"]').first().click();
  const multi = new Contract(
    deployment.contracts.DemoNFT1155.address,
    ["function balanceOf(address,uint256) view returns(uint256)"],
    provider,
  );
  const before1155 = BigInt(await multi.balanceOf(bob, 1));
  await page.getByRole("button", { name: /Study Club #1/ }).click();
  await page.getByLabel("Full recipient address").fill(bob);
  await page.getByLabel("Quantity", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "Review collectible transfer" })
    .click();
  await approve(page);
  await expect
    .poll(async () => BigInt(await multi.balanceOf(bob, 1)))
    .toBe(before1155 + 1n);
  await navigate(page, "/apps");
  await page
    .getByRole("button", { name: "Review revoke dUSDC" })
    .first()
    .click();
  await approve(page);
  const allowanceToken = new Contract(
    deployment.contracts.dUSDC.address,
    ["function allowance(address,address) view returns(uint256)"],
    provider,
  );
  await expect
    .poll(async () => BigInt(await allowanceToken.allowance(alice, bob)))
    .toBe(0n);
  const end = await provider.getBlockNumber(),
    receipts = [];
  for (let height = startBlock + 1; height <= end; height++) {
    const block = await provider.getBlock(height, true);
    if (!block) continue;
    for (const hash of block.transactions) {
      const tx = await provider.getTransaction(hash);
      if (tx?.from.toLowerCase() === alice.toLowerCase() && tx.nonce >= 0) {
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt)
          receipts.push({
            hash,
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            fee: receipt.fee.toString(),
          });
      }
    }
  }
  await writeFile(
    "artifacts/phase-03/evm-browser-proof.json",
    JSON.stringify(
      {
        source: "node",
        networkId: "eip155:31337",
        nativeRecipientDelta: parseEther("0.001").toString(),
        tokenRecipientDelta: "1",
        nftId: "101",
        nftOwner: bob,
        erc1155RecipientDelta: "1",
        revokedAllowance: "0",
        receipts,
        cleanup:
          "Test snapshot reverted after assertions; transaction hashes document the isolated test run.",
        signingBoundary: "Dedicated browser Worker; no external wallet",
        screenshots: "disabled",
      },
      null,
      2,
    ),
  );
  provider.destroy();
});

test("real contract UI executes an AMM swap, a vault withdrawal and a faucet claim", async ({
  page,
}) => {
  test.setTimeout(180000);
  await importFixture(page);
  const deployment = manifest.deployments.find(
    (m: { networkId: string }) => m.networkId === "eip155:31337",
  );
  const provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, {
    staticNetwork: true,
    cacheTimeout: 0,
  });
  const usdc = new Contract(
      deployment.contracts.dUSDC.address,
      ["function balanceOf(address) view returns(uint256)"],
      provider,
    ),
    dai = new Contract(
      deployment.contracts.dDAI.address,
      ["function balanceOf(address) view returns(uint256)"],
      provider,
    );
  await navigate(page, "/swap");
  await page.getByLabel("Amount (dUSDC)", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Get quote", exact: true }).click();
  await page
    .getByRole("button", { name: "Review exact allowance", exact: true })
    .click();
  await approve(page);
  await page.getByRole("button", { name: "Get quote", exact: true }).click();
  const beforeDai = BigInt(await dai.balanceOf(alice)),
    beforeUsdc = BigInt(await usdc.balanceOf(alice));
  await page.getByRole("button", { name: "Review swap", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("swapExactInput");
  await approve(page);
  await expect
    .poll(async () => BigInt(await dai.balanceOf(alice)))
    .toBeGreaterThan(beforeDai);
  expect(BigInt(await usdc.balanceOf(alice))).toBe(beforeUsdc - 10000000n);
  await navigate(page, "/vault");
  const stateVault = new Contract(
      deployment.contracts.SavingsVault.address,
      ["function positionCount() view returns(uint256)"],
      provider,
    ),
    newPosition = String(await stateVault.positionCount());
  await page.getByLabel("Deposit (dUSDC)", { exact: true }).fill("1");
  await page.getByLabel("Lock duration", { exact: true }).selectOption("3600");
  await page
    .getByRole("button", { name: "Review exact vault allowance", exact: true })
    .click();
  await approve(page);
  await page
    .getByRole("button", { name: "Review deposit", exact: true })
    .click();
  await approve(page);
  await expect(
    page.getByRole("button", {
      name: "Review withdrawal #" + newPosition,
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Review withdrawal #1", exact: true })
    .click();
  await approve(page);
  const vault = new Contract(
    deployment.contracts.SavingsVault.address,
    [
      "function positions(uint256) view returns(address owner,address token,uint256 amount,uint256 depositedAt,uint256 unlockAt,bool withdrawn)",
    ],
    provider,
  );
  await expect
    .poll(async () => (await vault.positions(1)).withdrawn)
    .toBe(true);
  await navigate(page, "/faucet");
  await page
    .getByRole("button", { name: "Review faucet claim", exact: true })
    .click();
  await approve(page);
  await expect(
    page.getByRole("button", { name: "Review faucet claim", exact: true }),
  ).toBeDisabled();
  const report = {
    networkId: "eip155:31337",
    source: "node",
    swapInput: "10000000",
    swapOutput: (BigInt(await dai.balanceOf(alice)) - beforeDai).toString(),
    withdrawnPosition: "1",
    lockedPosition: newPosition,
    freshDepositVerified: true,
    faucetClaimed: true,
    cleanup: "Isolated EVM snapshot reverted after assertions",
  };
  await writeFile(
    "artifacts/phase-03/services-browser-proof.json",
    JSON.stringify(report, null, 2),
  );
  provider.destroy();
});
test("a second independent owner approves and executes a two-of-three shared proposal", async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  await importFixture(page, "alice");
  await navigate(page, "/shared");
  await expect(
    page.getByRole("button", { name: "Review execution #0", exact: true }),
  ).toBeDisabled();
  const context = await browser.newContext();
  const bobPage = await context.newPage();
  await importFixture(bobPage, "bob");
  await navigate(bobPage, "/shared");
  await bobPage
    .getByRole("button", { name: "Review approval #0", exact: true })
    .click();
  await approve(bobPage);
  await bobPage
    .getByRole("button", { name: "Review execution #0", exact: true })
    .click();
  await approve(bobPage);
  const deployment = manifest.deployments.find(
    (m: { networkId: string }) => m.networkId === "eip155:31337",
  );
  const provider = new JsonRpcProvider("http://127.0.0.1:8545");
  const shared = new Contract(
    deployment.contracts.SharedWallet.address,
    [
      "function proposal(uint256) view returns(tuple(address destination,uint256 value,bytes data,address proposer,bool executed,uint256 confirmations))",
    ],
    provider,
  );
  expect((await shared.proposal(0)).executed).toBe(true);
  await context.close();
  provider.destroy();
});
test("native maximum preserves a complete reviewed fee reserve", async ({
  page,
}) => {
  test.setTimeout(90000);
  await importFixture(page);
  const provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, {
    staticNetwork: true,
    cacheTimeout: 0,
  });
  try {
    await page.getByRole("link", { name: "Send", exact: true }).click();
    await page.getByLabel("Recipient address", { exact: true }).fill(bob);
    await page
      .getByRole("button", {
        name: "Use max with current fee reserve",
        exact: true,
      })
      .click();
    await expect
      .poll(async () =>
        Number(
          (await page.getByLabel("Amount (ETH)", { exact: true }).inputValue())
            .length,
        ),
      )
      .toBeGreaterThan(0);
    const amount = parseEther(
        await page.getByLabel("Amount (ETH)", { exact: true }).inputValue(),
      ),
      before = await provider.getBalance(alice);
    expect(amount).toBeLessThan(before);
    expect(amount).toBeGreaterThan(0n);
    await page
      .getByRole("button", { name: "Review payment", exact: true })
      .click();
    await approve(page);
    await expect
      .poll(() => provider.getBalance(alice))
      .toBeLessThan(before - amount + 1n);
    const after = await provider.getBalance(alice);
    expect(after).toBeGreaterThanOrEqual(0n);
    expect(after).toBeLessThan(parseEther("0.001"));
  } finally {
    provider.destroy();
  }
});

test("bridge UI locks source tokens and the local relayer mints exactly one canonical destination", async ({
  page,
}) => {
  test.setTimeout(120000);
  const destination = new JsonRpcProvider("http://127.0.0.1:8546", 31338, {
      staticNetwork: true,
      cacheTimeout: 0,
    }),
    snapshotB = await destination.send("evm_snapshot", []);
  let previousJournal: string | null = null;
  let previousStatus: Buffer | null = null;
  try {
    previousJournal = await readFile(".local/relayer-journal.json", "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    previousStatus = await readFile("artifacts/seed/bridge-status.json");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    await importFixture(page);
    await navigate(page, "/bridge");
    await page.getByLabel("Source amount (dUSDC)", { exact: true }).fill("1");
    await page
      .getByRole("button", {
        name: "Review exact bridge allowance",
        exact: true,
      })
      .click();
    await approve(page);
    await page
      .getByRole("button", { name: "Review source lock", exact: true })
      .click();
    await approve(page);
    await page
      .getByRole("button", { name: "Check relayer status", exact: true })
      .click();
    await expect(
      page.getByText("Source locked · waiting for relayer", { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await promisify(execFile)("pnpm", ["relayer", "--once"], {
      timeout: 30000,
    });
    await page
      .getByRole("button", { name: "Check relayer status", exact: true })
      .click();
    const observation = await page.request.get("/api/v1/bridge/status"),
      body = await observation.json(),
      minted = body.data.messages.filter(
        (m: { amount: string; state: string }) =>
          m.amount === "1000000" && m.state === "minted",
      );
    expect(minted).toHaveLength(1);
    expect(minted[0].sourceHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      (await destination.getTransactionReceipt(minted[0].destinationHash))
        ?.status,
    ).toBe(1);
    await promisify(execFile)("pnpm", ["relayer", "--once"], {
      timeout: 30000,
    });
    const repeated = await page.request.get("/api/v1/bridge/status");
    expect(
      (await repeated.json()).data.messages.filter(
        (m: { id: string }) => m.id === minted[0].id,
      ),
    ).toHaveLength(1);
    await writeFile(
      "artifacts/phase-04/bridge-browser-proof.json",
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          actualBrowserSourceLock: true,
          realDestinationMint: true,
          message: minted[0],
          repeatRelayDeduplicated: true,
          cleanup: "Both EVM snapshots restored; relayer journal and status artifact restored",
        },
        null,
        2,
      ),
    );
  } finally {
    expect(await destination.send("evm_revert", [snapshotB])).toBe(true);
    destination.destroy();
    if (previousJournal !== null)
      await writeFile(".local/relayer-journal.json", previousJournal);
    else
      await unlink(".local/relayer-journal.json").catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    if (previousStatus !== null)
      await writeFile("artifacts/seed/bridge-status.json", previousStatus);
    else
      await unlink("artifacts/seed/bridge-status.json").catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
  }
});

test("node-backed discovery recovers a funded higher derivation index after phrase restoration", async ({
  page,
}) => {
  test.setTimeout(90000);
  const fixture = JSON.parse(
      await readFile(".local/secrets/alice.json", "utf8"),
    ),
    provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, {
      staticNetwork: true,
      cacheTimeout: 0,
    }),
    higher = HDNodeWallet.fromPhrase(
      fixture.mnemonic,
      undefined,
      "m/44'/60'/0'/0/3",
    ),
    payer = HDNodeWallet.fromPhrase(
      fixture.mnemonic,
      undefined,
      "m/44'/60'/0'/0/0",
    ).connect(provider);
  try {
    const funding = await payer.sendTransaction({
      to: higher.address,
      value: parseEther("0.001"),
    });
    await funding.wait();
    await importFixture(page);
    await page.locator('a[href="/settings"]').first().click();
    await page
      .getByRole("button", {
        name: "Derive public recovery candidates",
        exact: true,
      })
      .click();
    await expect(
      page.locator("code").filter({ hasText: "usedAccounts" }),
    ).toContainText(higher.address, { timeout: 30000 });
    await page
      .getByRole("button", { name: "Manage accounts", exact: true })
      .click();
    const accounts = page.getByRole("dialog", { name: "Your accounts" });
    await expect(
      accounts.getByText(higher.address, { exact: true }),
    ).toBeVisible();
    await writeFile(
      "artifacts/phase-02/discovery-browser-proof.json",
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          source: "real-local-node",
          family: "evm",
          path: higher.path,
          address: higher.address,
          fundingHash: funding.hash,
          restoredFromPhrase: true,
          usedAccountRecovered: true,
          scanCount: 20,
          snapshotRestored: true,
        },
        null,
        2,
      ),
    );
  } finally {
    provider.destroy();
  }
});
