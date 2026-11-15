import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { networkRpc } from "../services/backend/src/node-rpc";
import {
  bitcoinRpc,
  bitcoinIdentity,
} from "../services/backend/src/bitcoin-rpc";
import {
  deriveWatchAddress,
  satoshis,
  validateWatch,
} from "@ewallet/chain-bitcoin";
import { solanaManifestSchema } from "@ewallet/domain";
const checks: Array<{ name: string; passed: boolean }> = [];
const check = (name: string, passed: boolean) => {
  checks.push({ name, passed });
  if (!passed) throw new Error("Seed assertion failed: " + name);
};
await new Promise<void>((resolve, reject) => {
  const child = spawn("pnpm", ["exec", "tsx", "scripts/assert-evm.ts"], {
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 ? resolve() : reject(new Error("EVM assertion failed")),
  );
});
const sol = solanaManifestSchema.parse(
  JSON.parse(await readFile("artifacts/seed/solana-manifest.json", "utf8")),
);
check(
  "Solana genesis",
  (await networkRpc("solana:local", "getGenesisHash")) === sol.genesisHash,
);
for (const account of sol.finalBalances) {
  const balance = (await networkRpc("solana:local", "getBalance", [
    account.address,
    { commitment: "confirmed" },
  ])) as { value: string };
  check("SOL balance " + account.name, balance.value === account.sol);
  const balances = new Map<string, bigint>();
  for (const program of [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ]) {
    const tokens = (await networkRpc(
      "solana:local",
      "getTokenAccountsByOwner",
      [
        account.address,
        { programId: program },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ],
    )) as {
      value: Array<{
        account: {
          data: {
            parsed: { info: { mint: string; tokenAmount: { amount: string } } };
          };
        };
      }>;
    };
    for (const token of tokens.value) {
      const info = token.account.data.parsed.info;
      balances.set(
        info.mint,
        (balances.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount),
      );
    }
  }
  for (const [key, expected] of Object.entries(account.tokens))
    check(
      "SPL balance " + account.name + ":" + key,
      String(balances.get(sol.mints[key].address) ?? 0n) === expected,
    );
}
const btc = JSON.parse(
    await readFile("artifacts/seed/bitcoin-manifest.json", "utf8"),
  ),
  identity = await bitcoinIdentity();
check("Bitcoin funding epoch", identity.ledgerFingerprint === btc.fundingEpoch);
const info = (await bitcoinRpc("getwalletinfo", [], "ewallet-watch")) as {
  private_keys_enabled: boolean;
};
check(
  "Bitcoin watch wallet has no private keys",
  info.private_keys_enabled === false,
);
const unspent = (await bitcoinRpc(
  "listunspent",
  [1, 9999999, [], true],
  "ewallet-watch",
)) as Array<{ address: string; amount: string }>;
for (const expected of btc.finalBalances) {
  const watch = validateWatch(
      btc.identities[expected.name].find(
        (w: { purpose: number }) => w.purpose === expected.purpose,
      ),
    ),
    addresses = new Set(
      ([0, 1] as const).flatMap((branch) =>
        Array.from(
          { length: 20 },
          (_, i) => deriveWatchAddress(watch, branch, i).address,
        ),
      ),
    ),
    total = unspent
      .filter((u) => addresses.has(u.address))
      .reduce((sum, u) => sum + BigInt(satoshis(u.amount)), 0n);
  check(
    "Bitcoin final balance " + expected.name + ":" + expected.purpose,
    String(total) === expected.total,
  );
}
for (const [id, stage] of Object.entries(btc.stages) as Array<
  [string, { txid: string }]
>) {
  const receipt = (await bitcoinRpc("getrawtransaction", [
    stage.txid,
    true,
  ])) as { confirmations?: string };
  check(
    "Bitcoin canonical six confirmations " + id,
    BigInt(receipt.confirmations ?? "0") >= 6n,
  );
}
await writeFile(
  "artifacts/phase-04/seed-assertions.json",
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      source: "real-local-nodes",
      passed: checks.length,
      checks,
    },
    null,
    2,
  ),
);
console.log(
  checks.length + " Solana/Bitcoin assertions passed, plus EVM assertions.",
);
