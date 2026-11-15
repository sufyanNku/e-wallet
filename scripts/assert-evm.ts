import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  JsonRpcProvider,
  Contract,
  keccak256,
  getAddress,
  ZeroAddress,
  parseEther,
} from "ethers";
import { deploymentSchema } from "@ewallet/domain/deployments";
import { abis } from "@ewallet/config/abis";
import { currentEpoch } from "../services/backend/src/environment";
const seed = JSON.parse(
  await readFile("artifacts/seed/evm-manifest.json", "utf8"),
);
const checks: Array<{
  networkId: string;
  name: string;
  passed: boolean;
  expected?: string;
  actual?: string;
}> = [];
for (const chain of [31337, 31338]) {
  const id = `eip155:${chain}`,
    manifest = deploymentSchema.parse(
      JSON.parse(
        await readFile(`artifacts/deployments/eip155-${chain}.json`, "utf8"),
      ),
    ),
    provider = new JsonRpcProvider(
      `http://127.0.0.1:${chain === 31337 ? 8545 : 8546}`,
      chain,
      { staticNetwork: true, cacheTimeout: 0, batchMaxCount: 1 },
    );
  const epoch = await currentEpoch(id);
  checks.push({
    networkId: id,
    name: "Current ledger epoch",
    passed: epoch.bootEpoch === manifest.bootEpoch,
  });
  const height = await provider.getBlockNumber();
  for (const [name, c] of Object.entries(manifest.contracts))
    checks.push({
      networkId: id,
      name: `${name} deployed bytecode`,
      passed: keccak256(await provider.getCode(c.address)) === c.codeHash,
    });
  const identities = seed.identities as Record<
    string,
    { evm: { address: string } }
  >;
  const finalBalances: Record<string, Record<string, string>> = {};
  for (const [name, root] of Object.entries(identities)) {
    finalBalances[name] = {
      native: (await provider.getBalance(root.evm.address)).toString(),
    };
  }
  for (const asset of manifest.assets.filter((a) => a.standard === "erc20")) {
    const token = new Contract(asset.reference, abis.DemoERC20, provider);
    const events = await token.queryFilter(
      token.filters.Transfer(),
      Number(manifest.deploymentBlock),
      height,
    );
    let supply = 0n;
    const expected = new Map<string, bigint>();
    for (const event of events) {
      const decoded = token.interface.parseLog(event);
      if (!decoded) continue;
      const from = getAddress(decoded.args[0]),
        to = getAddress(decoded.args[1]),
        amount = BigInt(decoded.args[2]);
      if (from === ZeroAddress) supply += amount;
      else expected.set(from, (expected.get(from) ?? 0n) - amount);
      if (to === ZeroAddress) supply -= amount;
      else expected.set(to, (expected.get(to) ?? 0n) + amount);
    }
    const actualSupply = BigInt(await token.totalSupply());
    checks.push({
      networkId: id,
      name: `${asset.symbol} supply reconciles with real mint/burn logs`,
      passed: actualSupply === supply,
      expected: supply.toString(),
      actual: actualSupply.toString(),
    });
    checks.push({
      networkId: id,
      name: `${asset.symbol} decimals`,
      passed: Number(await token.decimals()) === asset.decimals,
    });
    for (const [name, root] of Object.entries(identities)) {
      const actual = BigInt(await token.balanceOf(root.evm.address)),
        want = expected.get(getAddress(root.evm.address)) ?? 0n;
      finalBalances[name][asset.symbol + "@" + asset.reference] =
        actual.toString();
      checks.push({
        networkId: id,
        name: `${name} ${asset.symbol} event/balance reconciliation`,
        passed: actual === want,
        expected: want.toString(),
        actual: actual.toString(),
      });
    }
  }
  if (chain === 31337) {
    const vault = new Contract(
        manifest.contracts.SavingsVault.address,
        abis.SavingsVault,
        provider,
      ),
      shared = new Contract(
        manifest.contracts.SharedWallet.address,
        abis.SharedWallet,
        provider,
      ),
      pool = new Contract(
        manifest.contracts.DemoSwapPool.address,
        abis.DemoSwapPool,
        provider,
      );
    const block = await provider.getBlock("latest");
    const positions = await Promise.all(
      [0, 1, 2].map((i) => vault.positions(i)),
    );
    checks.push({
      networkId: id,
      name: "Vault withdrawn / withdrawable / one-hour principal fixture (maturity follows chain time)",
      actual:BigInt(positions[2].unlockAt)>BigInt(block!.timestamp)?"one-hour position locked":"one-hour position matured without automatic withdrawal",
      passed:
        positions[0].withdrawn &&
        !positions[1].withdrawn &&
        BigInt(positions[1].unlockAt) <= BigInt(block!.timestamp) &&
        !positions[2].withdrawn &&
        BigInt(positions[2].unlockAt)-BigInt(positions[2].depositedAt) === 3600n,
    });
    checks.push({
      networkId: id,
      name: "Shared threshold exactly two",
      passed: BigInt(await shared.THRESHOLD()) === 2n,
    });
    checks.push({
      networkId: id,
      name: "Independent shared owners",
      passed:
        new Set(await Promise.all([0, 1, 2].map((i) => shared.owners(i))))
          .size === 3,
    });
    checks.push({
      networkId: id,
      name: "One approval pending and two-owner executed examples",
      passed:
        BigInt((await shared.proposal(0)).confirmations) === 1n &&
        !(await shared.proposal(0)).executed &&
        (await shared.proposal(1)).executed,
    });
    const t0 = new Contract(
        manifest.contracts.dUSDC.address,
        abis.DemoERC20,
        provider,
      ),
      t1 = new Contract(
        manifest.contracts.dDAI.address,
        abis.DemoERC20,
        provider,
      );
    checks.push({
      networkId: id,
      name: "Pool reserves equal actual token holdings after real swap",
      passed:
        BigInt(await pool.reserve0()) ===
          BigInt(await t0.balanceOf(manifest.contracts.DemoSwapPool.address)) &&
        BigInt(await pool.reserve1()) ===
          BigInt(await t1.balanceOf(manifest.contracts.DemoSwapPool.address)),
    });
    const nft = new Contract(
        manifest.contracts.DemoNFT721.address,
        abis.DemoNFT721,
        provider,
      ),
      multi = new Contract(
        manifest.contracts.DemoNFT1155.address,
        abis.DemoNFT1155,
        provider,
      );
    checks.push({
      networkId: id,
      name: "Transferred ERC-721 ownership",
      passed:
        getAddress(await nft.ownerOf(102)) ===
        getAddress(identities.bob.evm.address),
    });
    checks.push({
      networkId: id,
      name: "Transferred ERC-1155 quantity",
      passed:
        BigInt(await multi.balanceOf(identities.carol.evm.address, 1)) === 2n,
    });
    const expectedNative = Object.fromEntries(
      Object.entries(identities).map(([name]) => [
        name,
        name === "dana" ? 0n : parseEther("100"),
      ]),
    );
    for (let n = Number(manifest.deploymentBlock); n <= height; n++) {
      const b = await provider.getBlock(n, true);
      if (!b) throw new Error("Missing block");
      for (const tx of b.prefetchedTransactions) {
        const receipt = await provider.getTransactionReceipt(tx.hash);
        if (!receipt) throw new Error("Missing receipt");
        for (const [name, root] of Object.entries(identities)) {
          if (getAddress(tx.from) === getAddress(root.evm.address))
            expectedNative[name] -=
              receipt.fee + (receipt.status === 1 ? tx.value : 0n);
          if (
            tx.to &&
            getAddress(tx.to) === getAddress(root.evm.address) &&
            receipt.status === 1
          )
            expectedNative[name] += tx.value;
        }
      }
    }
    for (const [name, expected] of Object.entries(expectedNative))
      checks.push({
        networkId: id,
        name: `${name} native balance includes actual transaction fees`,
        passed: BigInt(finalBalances[name].native) === expected,
        expected: expected.toString(),
        actual: finalBalances[name].native,
      });
  }
  await mkdir("artifacts/phase-03", { recursive: true });
  await writeFile(
    `artifacts/phase-03/final-balances-${chain}.json`,
    JSON.stringify(
      {
        source: "node",
        networkId: id,
        observedHeight: String(height),
        observedAt: new Date().toISOString(),
        balances: finalBalances,
      },
      null,
      2,
    ) + "\n",
  );
  provider.destroy();
}
await writeFile(
  "artifacts/phase-03/evm-assertions.json",
  JSON.stringify({ source: "node", checks }, null, 2) + "\n",
);
console.log(
  `${checks.filter((c) => c.passed).length}/${checks.length} actual EVM ledger assertions passed.`,
);
if (checks.some((c) => !c.passed)) process.exitCode = 1;
