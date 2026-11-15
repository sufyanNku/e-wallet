import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises";
import { networks } from "@ewallet/config";
import { rpcUpstream } from "../services/backend/src/rpc";
import {
  createSecret,
  recoveryWords,
  derivePublic,
} from "../packages/wallet-core/src/derivation";
import { executeTestnetEvm } from "./testnet-evm";
import { executeTestnetSolana } from "./testnet-solana";
import { z } from "zod";
const directory = ".local/testnet/secrets";
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
await mkdir("artifacts/seed", { recursive: true });
type Result = {
  networkId: string;
  state: "passed" | "failed" | "blocked_funding" | "blocked_rpc" | "not_run";
  address: string;
  recipient: string;
  balance: string | null;
  observedIdentity: string | null;
  reason?: string;
  evidence?: unknown;
  faucet?: string;
  observedAt: string;
};
const results: Result[] = [];
const faucets: Record<string, string> = {
  "eip155:11155111": "https://faucets.chain.link/sepolia",
  "eip155:84532": "https://docs.base.org/base-chain/tools/network-faucets",
  "eip155:80002": "https://faucet.polygon.technology",
  "eip155:97": "https://testnet.bnbchain.org/faucet-smart",
  "eip155:998": "https://app.hyperliquid-testnet.xyz/drip",
  "eip155:46630": "https://faucet.testnet.chain.robinhood.com",
  "eip155:5042002": "https://faucet.circle.com",
  "solana:devnet": "https://faucet.solana.com",
};
for (const profile of networks.filter((n) => n.environment === "testnet")) {
  const path = directory + "/" + profile.id.replace(":", "-") + ".json";
  let secret: ReturnType<typeof createSecret>;
  try {
    secret = z
      .object({
        entropyHex: z.string().regex(/^[a-f0-9]{64}$/),
        passphrase: z.literal(""),
        derivationVersion: z.literal(1),
      })
      .strict()
      .parse(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Invalid testnet identity file; refusing replacement", {
        cause: e,
      });
    secret = createSecret("");
    await writeFile(path, JSON.stringify(secret), { mode: 0o600, flag: "wx" });
  }
  await chmod(path, 0o600);
  const account = derivePublic(secret, "testnet-only", {
      family: profile.family,
      index: 0,
    }),
    recipient = derivePublic(secret, "testnet-only", {
      family: profile.family,
      index: 1,
    }),
    row: Result = {
      networkId: profile.id,
      state: "blocked_rpc",
      address: account.address,
      recipient: recipient.address,
      balance: null,
      observedIdentity: null,
      faucet: faucets[profile.id],
      observedAt: new Date().toISOString(),
    };
  const rpc = async (method: string, params: unknown[] = []) => {
    const result = (await rpcUpstream(
      profile.rpcs[0],
      method,
      params,
      undefined,
      profile.family === "solana",
    )) as { result?: unknown; error?: { code: number } };
    if (result.error)
      throw new Error("RPC rejected request (" + result.error.code + ")");
    return result.result;
  };
  try {
    row.observedIdentity =
      profile.family === "evm"
        ? BigInt(String(await rpc("eth_chainId"))).toString()
        : String(await rpc("getGenesisHash"));
    if (row.observedIdentity !== profile.identity) {
      row.state = "failed";
      row.reason = "Node identity differs from the approved test profile.";
      results.push(row);
      continue;
    }
    row.balance =
      profile.family === "evm"
        ? BigInt(
            String(await rpc("eth_getBalance", [account.address, "latest"])),
          ).toString()
        : String(
            (
              (await rpc("getBalance", [
                account.address,
                { commitment: "confirmed" },
              ])) as { value: string }
            ).value,
          );
    if (profile.family === "solana" && BigInt(row.balance) < 100000000n) {
      const attemptPath = ".local/testnet/devnet-airdrop.json";
      let previous: { attemptedAt?: string; signature?: string } = {};
      try {
        previous = JSON.parse(await readFile(attemptPath, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (
        !previous.attemptedAt ||
        Date.now() - Date.parse(previous.attemptedAt) > 86400000
      ) {
        const attempt = {
          attemptedAt: new Date().toISOString(),
          address: account.address,
        };
        await writeFile(attemptPath, JSON.stringify(attempt));
        try {
          const signature = String(
            await rpc("requestAirdrop", [account.address, 1000000000]),
          );
          await writeFile(
            attemptPath,
            JSON.stringify({ ...attempt, signature }),
          );
          for (let i = 0; i < 20; i++) {
            const state = (await rpc("getSignatureStatuses", [
              [signature],
              { searchTransactionHistory: true },
            ])) as {
              value: Array<{ err: unknown; confirmationStatus: string } | null>;
            };
            if (
              state.value[0]?.err === null &&
              ["confirmed", "finalized"].includes(
                state.value[0].confirmationStatus,
              )
            )
              break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          row.balance = String(
            (
              (await rpc("getBalance", [
                account.address,
                { commitment: "confirmed" },
              ])) as { value: string }
            ).value,
          );
        } catch {
          row.reason =
            "The free Devnet airdrop is unavailable or rate limited. No retry flood or paid funding was used.";
        }
      }
    }
    const minimum =
      profile.family === "solana"
        ? 100000000n
        : profile.id === "eip155:5042002"
          ? 10000000000000000n
          : 1000000000000000n;
    if (BigInt(row.balance) < minimum) {
      row.state = "blocked_funding";
      row.reason ??=
        "Random testnet identity lacks the small gas allocation needed for the complete fixture. Use a legitimate free faucet; human checks are not bypassed.";
    } else {
      try {
        row.evidence =
          profile.family === "evm"
            ? await executeTestnetEvm(
                profile,
                recoveryWords(secret).join(" "),
                recipient.address,
              )
            : await executeTestnetSolana(profile, secret, recipient.address);
        row.state = "passed";
      } catch (e) {
        row.state = "failed";
        row.reason =
          e instanceof Error ? e.message : "Public test execution failed";
      }
    }
  } catch (e) {
    row.state = "blocked_rpc";
    row.reason = e instanceof Error ? e.message : "Public RPC unavailable";
  }
  results.push(row);
  console.log(profile.id + ": " + row.state);
  await writeFile(
    "artifacts/seed/testnet-manifest.json.tmp",
    JSON.stringify(
      {
        schemaVersion: 1,
        mode: "testnet",
        observedAt: new Date().toISOString(),
        identities: "Random testnet-only keys kept outside version control",
        bitcoin: {
          networkId: "bitcoin:regtest",
          state: "not_run",
          reason:
            "Bitcoin remains an independently evaluated local regtest chain.",
        },
        results,
      },
      null,
      2,
    ),
  );
  await rename(
    "artifacts/seed/testnet-manifest.json.tmp",
    "artifacts/seed/testnet-manifest.json",
  );
}
if (results.some((r) => r.state === "failed")) process.exitCode = 1;
