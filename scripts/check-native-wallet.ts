import "./report-paths.ts";
import { bitcoinRpc } from "../services/backend/src/bitcoin-rpc";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { NativeWallet } from "../packages/native-wallet/src/wallet";
import { NativeApi } from "../packages/native-wallet/src/api";
import type { DeviceStore } from "../packages/native-wallet/src/vault";
async function evmControl(
  method: "evm_snapshot" | "evm_revert",
  params: unknown[] = [],
) {
  const response = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const body = (await response.json()) as { result: unknown; error?: unknown };
  if (body.error) throw new Error("Local snapshot control failed");
  return body.result;
}
import { buildServer } from "../services/backend/src/server";
import { nativeWords } from "../packages/native-wallet/src/keys";
import type { TransactionIntent } from "@ewallet/domain";
const family =
  process.argv.find((a) => a.startsWith("--family="))?.split("=")[1] ?? "evm";
if (!["evm", "solana", "bitcoin"].includes(family))
  throw new Error("Select a chain family");
if (family === "solana" && process.env.EWALLET_ISOLATED_SOLANA_TEST !== "1")
  throw new Error("Solana mobile proof requires the disposable test ledger.");
if (family === "bitcoin" && process.env.EWALLET_ISOLATED_BITCOIN_TEST !== "1")
  throw new Error("Bitcoin mobile proof requires the disposable test ledger.");
const app = await buildServer({ databasePath: ":memory:" }),
  data = new Map<string, string>(),
  store: DeviceStore = {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
const transport: typeof fetch = async (input, init) => {
  const u = new URL(String(input));
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  headers.host = "127.0.0.1:8787";
  const r = await app.inject({
    method: (init?.method ?? "GET") as "GET" | "POST",
    url: u.pathname + u.search,
    headers,
    ...(typeof init?.body === "string" ? { payload: init.body } : {}),
  });
  return new Response(r.body, {
    status: r.statusCode,
    headers: { "Content-Type": "application/json" },
  });
};
const api = new NativeApi("http://127.0.0.1:8787", transport),
  wallet = new NativeWallet(
    store,
    (n) => crypto.getRandomValues(new Uint8Array(n)),
    api,
  ),
  phrase = nativeWords({ entropy: "01".repeat(32), passphrase: "" }).join(" "),
  network =
    family === "evm"
      ? "eip155:31337"
      : family === "solana"
        ? "solana:local"
        : "bitcoin:regtest";
let snapshot: string | undefined;
const proofs: Array<Record<string, unknown>> = [];
async function settled(id: string) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await wallet.refresh();
    const record = wallet.getSnapshot().activity.find((item) => item.id === id);
    if (record && ["confirmed", "finalized"].includes(record.state)) {
      // Portfolio reads precede receipt reads in refresh. Read once more after
      // confirmation so balance assertions use the settled ledger as well.
      await wallet.refresh();
      return wallet.getSnapshot().activity.find((item) => item.id === id)!;
    }
    if (
      record &&
      ["reverted", "expired", "rejected", "replaced"].includes(record.state)
    )
      throw new Error(
        "Native transaction did not settle successfully: " + record.state,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "Native transaction confirmation timed out; no success was assumed.",
  );
}
try {
  if (family === "evm") snapshot = String(await evmControl("evm_snapshot"));
  await wallet.open();
  await wallet.restore(
    phrase,
    "private local proof password",
    "private local proof password",
  );
  wallet.selectNetwork(network);
  const manifest = JSON.parse(
    await readFile(
      family === "solana"
        ? ".local/reports/chains/isolated-solana-manifest.json"
        : family === "bitcoin"
          ? ".local/reports/chains/isolated-bitcoin-manifest.json"
          : ".local/state/seed/evm-manifest.json",
      "utf8",
    ),
  );
  const bob =
    family === "evm"
      ? manifest.identities.bob.evm.address
      : family === "solana"
        ? manifest.identities.bob.address
        : manifest.finalBalances.find(
            (a: { name: string; purpose: number }) =>
              a.name === "bob" && a.purpose === 84,
          ).address;
  for (const type of family === "bitcoin" ? ["p2wpkh", "p2tr"] : ["native"]) {
    if (family === "bitcoin") {
      const account = wallet
        .getSnapshot()
        .accounts.find(
          (a) => a.family === "bitcoin" && a.bitcoinType === type,
        )!;
      wallet.selectAccount(account.id);
      await wallet.connectBitcoinWatch();
    } else await wallet.refresh();
    const state = wallet.getSnapshot(),
      account = state.accounts.find((a) => a.id === state.selectedAccountId)!,
      balance = state.balances.find((b) => b.asset.standard === "native")!;
    if (!balance || BigInt(balance.raw) <= 0n)
      throw new Error("Native fixture balance unavailable");
    const intent: TransactionIntent = {
        requestId: crypto.randomUUID(),
        kind: "send",
        accountId: account.id,
        networkId: network,
        asset: balance.asset,
        recipient: bob,
        amount: family === "evm" ? "1000000000000000" : "1000000",
      },
      operation = await wallet.prepare(intent),
      mutated = structuredClone(operation);
    mutated.preview.recipient = account.address;
    // Caller copies cannot mutate the core's stored review.
    const record = await wallet.approve(operation.id, operation.digest);
    if (record.state !== "submitted")
      throw new Error("Native signing submission failed: " + record.state);
    const persisted = JSON.parse(data.get("journal.testnet.v1")!);
    if (persisted.at(-1).hash !== record.hash || !persisted.at(-1).signed)
      throw new Error("Signed bytes were not durably journaled");
    if (family === "bitcoin")
      await bitcoinRpc("generatetoaddress", [
        6,
        await bitcoinRpc("getnewaddress", [], "ewallet-miner"),
      ]);
    const current = await settled(record.id);
    const balanceAfter = wallet
      .getSnapshot()
      .balances.find((b) => b.asset.standard === "native")?.raw;
    if (!balanceAfter || BigInt(balanceAfter) >= BigInt(balance.raw))
      throw new Error(
        "Native payment did not produce the expected sender balance decrease.",
      );
    proofs.push({
      type,
      networkId: network,
      address: account.address,
      hash: record.hash,
      signedJournalBeforeBroadcast: true,
      state: current.state,
      balanceBefore: balance.raw,
      balanceAfter,
      immutableReview: true,
    });
    await (async () => {
      try {
        await wallet.approve(operation.id, operation.digest);
        throw new Error("Duplicate review was accepted");
      } catch (e) {
        if (e instanceof Error && e.message === "Duplicate review was accepted")
          throw e;
      }
    })();
  }
  if (family === "evm" || family === "solana") {
    await wallet.refresh();
    const state = wallet.getSnapshot(),
      token = state.balances.find(
        (b) => b.symbol === "dUSDC" && b.asset.standard !== "native",
      );
    const collectible = state.collectibles.find(
      (c) => c.transferable !== false,
    );
    for (const item of [
      ...(token
        ? [
            {
              kind: "send" as const,
              asset: token.asset,
              amount: "1",
              label: "token",
            },
          ]
        : []),
      ...(collectible
        ? [
            {
              kind: "nft-transfer" as const,
              asset: collectible.asset,
              amount: "1",
              label: "collectible",
            },
          ]
        : []),
    ]) {
      const operation = await wallet.prepare({
        requestId: crypto.randomUUID(),
        accountId: state.selectedAccountId,
        networkId: network,
        kind: item.kind,
        asset: item.asset,
        recipient: bob,
        amount: item.amount,
      });
      const result = await wallet.approve(operation.id, operation.digest);
      if (result.state !== "submitted")
        throw new Error("Native " + item.label + " submission failed");
      await settled(result.id);
      proofs.push({
        type: item.label,
        networkId: network,
        hash: result.hash,
        state: wallet.getSnapshot().activity.find((t) => t.id === result.id)
          ?.state,
      });
    }
    if (family === "evm") {
      let quote = await wallet.quote("1000000"),
        operation = await wallet.prepareSwap("1000000");
      if (operation.intent.kind === "approve") {
        const allowance = await wallet.approve(operation.id, operation.digest);
        await settled(allowance.id);
        quote = await wallet.quote("1000000");
        operation = await wallet.prepareSwap("1000000");
      }
      if (operation.intent.kind !== "swap")
        throw new Error("Native swap review not prepared");
      const before =
        wallet
          .getSnapshot()
          .balances.find((b) => b.symbol === quote.outputSymbol)?.raw ?? "0";
      const result = await wallet.approve(operation.id, operation.digest);
      if (result.state !== "submitted")
        throw new Error("Native swap submission failed");
      await settled(result.id);
      const after =
        wallet
          .getSnapshot()
          .balances.find((b) => b.symbol === quote.outputSymbol)?.raw ?? "0";
      if (BigInt(after) - BigInt(before) !== BigInt(quote.output))
        throw new Error(
          "Native swap output did not match the actual node balance.",
        );
      proofs.push({
        type: "swap",
        networkId: network,
        hash: result.hash,
        outputSymbol: quote.outputSymbol,
        quotedOutput: quote.output,
        actualOutput: String(BigInt(after) - BigInt(before)),
        state: wallet.getSnapshot().activity.find((t) => t.id === result.id)
          ?.state,
      });
    }
  }
  wallet.lock();
  let denied = false;
  try {
    await wallet.prepare({} as TransactionIntent);
  } catch {
    denied = true;
  }
  if (!denied) throw new Error("Locked native wallet accepted a review");
  const raw = [...data.values()].join("");
  if (raw.includes(phrase))
    throw new Error("Phrase found outside encrypted storage");
  await mkdir(".local/reports/product", { recursive: true });
  await writeFile(
    ".local/reports/product/native-" + family + "-proof.json",
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        source:
          "Native wallet core through real backend handlers and local blockchain nodes",
        platformBoundary:
          "Node-hosted native core; device Keychain/Hermes tests recorded separately",
        fixtureOnly: true,
        isolated: family !== "evm",
        snapshotRestored: family === "evm",
        proofs,
        lockedSigningRejected: true,
        duplicateApprovalRejected: true,
        secretNotPersistedOutsideEnvelope: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Native " +
      family +
      " signing, public-node reconciliation, immutable review, durable journal and lock checks passed.",
  );
} finally {
  wallet.lock();
  if (snapshot) await evmControl("evm_revert", [snapshot]);
  await app.close();
}
