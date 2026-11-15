import { readFile } from "node:fs/promises";
import { rpcUpstream } from "./rpc";
import {
  REGTEST_GENESIS,
  publicDescriptor,
  type BitcoinWatch,
} from "@ewallet/chain-bitcoin";
export class BitcoinRpcError extends Error {
  constructor(
    readonly code: string,
    method: string,
  ) {
    super(`Regtest ${method} failed (${code})`);
  }
}
export async function bitcoinRpc(
  method: string,
  params: unknown[] = [],
  wallet?: "ewallet-watch" | "ewallet-miner",
) {
  const auth =
    "Basic " +
    Buffer.from(
      (
        await readFile(
          process.env.EWALLET_ISOLATED_BITCOIN_TEST === "1"
            ? ".local/secrets/bitcoin-browser/auth.cookie"
            : ".local/secrets/bitcoin/auth.cookie",
          "utf8",
        )
      ).trim(),
    ).toString("base64");
  const result = (await rpcUpstream(
    (process.env.EWALLET_ISOLATED_BITCOIN_TEST === "1"
      ? "http://127.0.0.1:18444"
      : "http://127.0.0.1:18443") + (wallet ? "/wallet/" + wallet : ""),
    method,
    params,
    auth,
    true,
  )) as { result?: unknown; error?: { code: string; message: string } };
  if (result.error) throw new BitcoinRpcError(result.error.code, method);
  return result.result;
}
export async function bitcoinIdentity() {
  const state = (await bitcoinRpc("getblockchaininfo")) as {
    chain: string;
    blocks: string;
    bestblockhash: string;
  };
  if (
    state.chain !== "regtest" ||
    (await bitcoinRpc("getblockhash", [0])) !== REGTEST_GENESIS
  )
    throw new Error(
      "Refusing a Bitcoin node outside the known regtest genesis",
    );
  return {
    ...state,
    ledgerFingerprint:
      state.blocks !== "0"
        ? String(await bitcoinRpc("getblockhash", [1]))
        : null,
  };
}

export async function ensurePublicDescriptor(
  watch: BitcoinWatch,
  branch: 0 | 1,
) {
  const info = (await bitcoinRpc("getdescriptorinfo", [
    publicDescriptor(watch, branch),
  ])) as { descriptor: string; hasprivatekeys: boolean };
  if (info.hasprivatekeys !== false)
    throw new Error("Private descriptor rejected");
  const current = (await bitcoinRpc(
    "listdescriptors",
    [false],
    "ewallet-watch",
  )) as {
    descriptors: Array<{
      desc: string;
      internal?: boolean;
      range?: [string, string];
    }>;
  };
  const existing = current.descriptors.find((d) => d.desc === info.descriptor);
  if (existing) {
    if (
      existing.internal !== undefined &&
      Boolean(existing.internal) !== (branch === 1)
    )
      throw new Error("Existing descriptor branch differs");
    if (
      existing.range &&
      BigInt(existing.range[0]) === 0n &&
      BigInt(existing.range[1]) >= 999n
    )
      return;
  }
  const end = Math.max(999, Number(existing?.range?.[1] ?? 0));
  const results = (await bitcoinRpc(
    "importdescriptors",
    [
      [
        {
          desc: info.descriptor,
          timestamp: 0,
          active: false,
          internal: branch === 1,
          range: [0, end],
        },
      ],
    ],
    "ewallet-watch",
  )) as Array<{ success: boolean }>;
  if (results.length !== 1 || results[0].success !== true)
    throw new Error("Public descriptor import failed");
}
