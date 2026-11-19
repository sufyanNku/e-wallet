import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SolanaAdapter } from "@ewallet/chain-solana";
import { solanaManifestSchema, type AccountRef } from "@ewallet/domain";
import { networkRpc } from "./node-rpc";
import {
  commitIndex,
  orphanFrom,
  type IndexedAsset,
  type IndexedTransaction,
  type IndexedTransfer,
} from "./index-storage";
import type { WatchRow } from "./public-indexer";
const raw = z.string().regex(/^[0-9]+$/),
  key = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const tokenBalance = z.object({
  accountIndex: raw,
  mint: key,
  owner: key.optional(),
  uiTokenAmount: z.object({ amount: raw, decimals: raw }),
});
const instruction = z.object({
  program: z.string().optional(),
  programId: key,
  parsed: z
    .object({ type: z.string(), info: z.record(z.string(), z.unknown()) })
    .optional(),
});
const transactionSchema = z.object({
  slot: raw,
  blockTime: raw.nullable(),
  transaction: z.object({
    signatures: z.array(z.string()),
    message: z.object({
      accountKeys: z.array(
        z.object({ pubkey: key, signer: z.boolean(), writable: z.boolean() }),
      ),
      instructions: z.array(instruction),
    }),
  }),
  meta: z.object({
    err: z.unknown().nullable(),
    fee: raw,
    preTokenBalances: z.array(tokenBalance).optional(),
    postTokenBalances: z.array(tokenBalance).optional(),
    innerInstructions: z
      .array(z.object({ index: raw, instructions: z.array(instruction) }))
      .nullable()
      .optional(),
  }),
});
export async function indexSolana(
  db: Database.Database,
  row: WatchRow,
  fingerprint: string,
) {
  const rpc = (method: string, params: unknown[] = []) =>
    networkRpc(row.network_id, method, params);
  let local: ConstructorParameters<typeof SolanaAdapter>[2];
  if (row.network_id === "solana:local") {
    const manifest = solanaManifestSchema.parse(
      JSON.parse(
        await readFile(
          process.env.EWALLET_ISOLATED_SOLANA_TEST === "1"
            ? ".local/reports/chains/isolated-solana-manifest.json"
            : ".local/state/seed/solana-manifest.json",
          "utf8",
        ),
      ),
    );
    local = {
      genesisHash: manifest.genesisHash,
      mints: Object.values(manifest.mints),
    };
  }
  const adapter = new SolanaAdapter(row.network_id, rpc, local),
    account: AccountRef = {
      id: row.id,
      rootWalletId: "public-index",
      family: "solana",
      address: row.address,
      path: "m/44'/501'/0'/0'",
      index: 0,
      name: "Watched public account",
    },
    portfolio = await adapter.portfolio(account),
    tokenAccounts = await adapter.tokenAccounts(account),
    slot = raw.parse(await rpc("getSlot", [{ commitment: "confirmed" }]));
  const blockAt = async (height: string) =>
    z
      .object({ blockhash: key, blockTime: raw.nullable().optional() })
      .nullable()
      .parse(
        await rpc("getBlock", [
          Number(height),
          {
            commitment: "confirmed",
            transactionDetails: "none",
            rewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ]),
      );
  const head = await blockAt(slot);
  if (!head) throw new Error("Solana confirmed head unavailable");
  const existing = db
    .prepare(
      "SELECT DISTINCT height,block_hash FROM transactions WHERE network_id=? AND fingerprint=? AND canonical=1 AND CAST(height AS INTEGER)>=?",
    )
    .all(
      row.network_id,
      fingerprint,
      Math.max(0, Number(slot) - 150),
    ) as Array<{ height: string; block_hash: string | null }>;
  for (const prior of existing) {
    const block = await blockAt(prior.height);
    if (!block || block.blockhash !== prior.block_hash)
      orphanFrom(db, row, prior.height);
  }
  const mintAssets = new Map<string, IndexedAsset>();
  for (const balance of portfolio.balances)
    mintAssets.set(balance.asset.reference, {
      asset: balance.asset,
      decimals: balance.decimals,
      symbol: balance.symbol,
      name: balance.name,
    });
  for (const collectible of portfolio.collectibles)
    mintAssets.set(collectible.asset.reference, {
      asset: collectible.asset,
      decimals: 0,
      symbol: "NFT",
      name: collectible.name,
    });
  const unsupportedMints = new Set<string>(),
    checkedMints = new Set<string>();
  async function asset(mint: string): Promise<IndexedAsset> {
    if (!checkedMints.has(mint)) {
      const checked = await adapter.mint(mint);
      checkedMints.add(mint);
      if (!checked.supported) unsupportedMints.add(mint);
    }
    const known = mintAssets.get(mint);
    if (known) return known;
    const m = await adapter.mint(mint),
      metadata = await adapter.metadata(mint),
      standard =
        metadata?.tokenStandard.__option === "Some"
          ? metadata.tokenStandard.value
          : -1,
      nft =
        m.mint.decimals === 0 &&
        m.mint.supply === 1n &&
        [0, 3, 4, 5].includes(standard),
      result: IndexedAsset = {
        asset: {
          networkId: row.network_id,
          standard: nft ? "solana-nft" : m.is2022 ? "token2022" : "spl",
          reference: mint,
        },
        decimals: m.mint.decimals,
        symbol:
          metadata?.symbol.replace(/\0/g, "").trim().slice(0, 30) ||
          mint.slice(0, 6),
        name:
          metadata?.name.replace(/\0/g, "").trim().slice(0, 100) ||
          "Unverified Solana mint",
      };
    mintAssets.set(mint, result);
    return result;
  }
  const addresses = new Set([
      row.address,
      ...tokenAccounts.map((a) => a.reference),
      ...(
        db
          .prepare("SELECT address FROM watched_subaccounts WHERE watch_id=?")
          .all(row.id) as Array<{ address: string }>
      ).map((a) => a.address),
    ]),
    signatures = new Map<
      string,
      {
        signature: string;
        slot: string;
        err: unknown;
        confirmationStatus: string | null;
      }
    >(),
    cursors: Array<{ kind: string; position: string; hash: string | null }> =
      [];
  let syncing = false;
  for (const address of addresses) {
    const kind = "solsig:" + address,
      stored = db
        .prepare(
          "SELECT position FROM sync_cursors WHERE watch_id=? AND kind=?",
        )
        .get(row.id, kind) as { position: string } | undefined,
      state = stored?.position.startsWith("{")
        ? z
            .object({
              newest: z.string(),
              before: z.string(),
              until: z.string().nullable(),
            })
            .strict()
            .parse(JSON.parse(stored.position))
        : null;
    let before: string | undefined = state?.before,
      newest: string | undefined = state?.newest,
      complete = false;
    const until = state ? state.until : (stored?.position ?? null);
    for (let page = 0; page < 2; page++) {
      const values = z
        .array(
          z.object({
            signature: z.string(),
            slot: raw,
            err: z.unknown().nullable(),
            confirmationStatus: z.string().nullable(),
          }),
        )
        .max(100)
        .parse(
          await rpc("getSignaturesForAddress", [
            address,
            {
              limit: 100,
              commitment: "confirmed",
              ...(before ? { before } : {}),
            },
          ]),
        );
      if (!values.length) {
        complete = true;
        break;
      }
      newest ??= values[0].signature;
      for (const value of values) {
        signatures.set(value.signature, value);
        if (value.signature === until) {
          complete = true;
          break;
        }
      }
      if (values.length < 100 || complete) {
        complete = true;
        break;
      }
      before = values.at(-1)!.signature;
    }
    if (newest) {
      cursors.push({
        kind,
        position: complete ? newest : JSON.stringify({ newest, before, until }),
        hash: head.blockhash,
      });
      if (!complete) syncing = true;
    }
  }
  const transactions: IndexedTransaction[] = [],
    transfers: IndexedTransfer[] = [];
  for (const observed of signatures.values()) {
    const response = await rpc("getTransaction", [
      observed.signature,
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (response === null) continue;
    const transaction = transactionSchema.parse(response),
      inclusion = await blockAt(transaction.slot);
    if (!inclusion) throw new Error("Solana transaction inclusion unavailable");
    const sender =
        transaction.transaction.message.accountKeys.find((a) => a.signer)
          ?.pubkey ?? null,
      state =
        transaction.meta.err !== null
          ? "reverted"
          : observed.confirmationStatus === "finalized"
            ? "finalized"
            : observed.confirmationStatus === "confirmed"
              ? "confirmed"
              : "included";
    transactions.push({
      hash: observed.signature,
      height: transaction.slot,
      blockHash: inclusion.blockhash,
      state,
      from: sender,
      to: null,
      fee: transaction.meta.fee,
      createdAt: transaction.blockTime
        ? new Date(Number(transaction.blockTime) * 1000).toISOString()
        : new Date().toISOString(),
      value: "0",
      data: {
        commitment: observed.confirmationStatus,
        timestampSource: transaction.blockTime
          ? "chain"
          : "observed-without-chain-timestamp",
        err: transaction.meta.err,
        coverage:
          "Parsed supported System/Token instructions and observed token balances; unavailable pruned signatures are not invented.",
      },
    });
    if (transaction.meta.err !== null) continue;
    const owners = new Map<string, string>();
    for (const balance of [
      ...(transaction.meta.preTokenBalances ?? []),
      ...(transaction.meta.postTokenBalances ?? []),
    ]) {
      const address =
        transaction.transaction.message.accountKeys[
          Number(balance.accountIndex)
        ]?.pubkey;
      if (address && balance.owner) owners.set(address, balance.owner);
    }
    const instructions = [
      ...transaction.transaction.message.instructions.map((value, index) => ({
        value,
        index: "outer:" + index,
      })),
      ...(transaction.meta.innerInstructions ?? []).flatMap((group) =>
        group.instructions.map((value, index) => ({
          value,
          index: "inner:" + group.index + ":" + index,
        })),
      ),
    ];
    for (const { value, index } of instructions) {
      const parsed = value.parsed;
      if (!parsed) continue;
      const info = parsed.info;
      if (value.program === "system" && parsed.type === "transfer") {
        const source = key.parse(info.source),
          destination = key.parse(info.destination),
          amount = raw.parse(info.lamports);
        if (source === row.address || destination === row.address)
          transfers.push({
            hash: observed.signature,
            index,
            asset: {
              asset: {
                networkId: row.network_id,
                standard: "native",
                reference: "native",
              },
              decimals: 9,
              symbol: "SOL",
              name: "Solana",
            },
            amount,
            from: source,
            to: destination,
            direction:
              source === row.address && destination === row.address
                ? "self"
                : source === row.address
                  ? "outgoing"
                  : "incoming",
          });
      } else if (
        ["spl-token", "spl-token-2022"].includes(value.program ?? "") &&
        [
          "transfer",
          "transferChecked",
          "mintTo",
          "mintToChecked",
          "burn",
          "burnChecked",
        ].includes(parsed.type)
      ) {
        const source = typeof info.source === "string" ? info.source : null,
          destination =
            typeof info.destination === "string"
              ? info.destination
              : typeof info.account === "string"
                ? info.account
                : null,
          from = source ? (owners.get(source) ?? null) : null,
          to = destination ? (owners.get(destination) ?? null) : null;
        if (from !== row.address && to !== row.address) continue;
        let mint = typeof info.mint === "string" ? info.mint : null;
        if (!mint) {
          const tokenBalances = [
            ...(transaction.meta.preTokenBalances ?? []),
            ...(transaction.meta.postTokenBalances ?? []),
          ];
          const matching = tokenBalances.find((b) =>
            [source, destination].includes(
              transaction.transaction.message.accountKeys[
                Number(b.accountIndex)
              ]?.pubkey,
            ),
          );
          mint = matching?.mint ?? null;
        }
        if (!mint) continue;
        const tokenAmount =
            info.tokenAmount && typeof info.tokenAmount === "object"
              ? "amount" in info.tokenAmount
                ? info.tokenAmount.amount
                : undefined
              : undefined,
          amount = raw.parse(info.amount ?? tokenAmount);
        const indexedAsset = await asset(mint);
        if (unsupportedMints.has(mint)) continue;
        transfers.push({
          hash: observed.signature,
          index,
          asset: indexedAsset,
          amount,
          from,
          to,
          direction:
            from === row.address && to === row.address
              ? "self"
              : from === row.address
                ? "outgoing"
                : "incoming",
        });
      }
    }
    const tokenMints = new Set(
      [
        ...(transaction.meta.preTokenBalances ?? []),
        ...(transaction.meta.postTokenBalances ?? []),
      ]
        .filter((b) => b.owner === row.address)
        .map((b) => b.mint),
    );
    for (const mint of tokenMints) {
      const indexedAsset = await asset(mint);
      if (
        !unsupportedMints.has(mint) &&
        transfers.some(
          (t) =>
            t.hash === observed.signature && t.asset.asset.reference === mint,
        )
      )
        continue;
      const total = (balances: typeof transaction.meta.preTokenBalances) =>
          (balances ?? [])
            .filter((b) => b.mint === mint && b.owner === row.address)
            .reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n),
        delta =
          total(transaction.meta.postTokenBalances) -
          total(transaction.meta.preTokenBalances);
      if (delta !== 0n)
        transfers.push({
          hash: observed.signature,
          index: "net-token-delta:" + mint,
          asset: indexedAsset,
          amount: String(delta < 0n ? -delta : delta),
          from: delta < 0n ? row.address : null,
          to: delta > 0n ? row.address : null,
          direction: delta > 0n ? "incoming" : "outgoing",
          data: {
            normalization: "observed net token balance change",
            unsupportedExtensions: unsupportedMints.has(mint),
          },
        });
    }
  }
  if ((await blockAt(slot))?.blockhash !== head.blockhash)
    throw new Error("Solana confirmed head changed before commit");
  const snapshots = [
    ...portfolio.balances.map((b) => ({
      asset: {
        asset: b.asset,
        decimals: b.decimals,
        symbol: b.symbol,
        name: b.name,
      },
      height: b.observation.observedHeight,
      blockHash: head.blockhash,
      amount: b.raw,
    })),
    ...portfolio.collectibles.map((c) => ({
      asset: { asset: c.asset, decimals: 0, symbol: "NFT", name: c.name },
      height: c.observation.observedHeight,
      blockHash: head.blockhash,
      amount: c.quantity,
    })),
  ];
  cursors.push({ kind: "solana", position: slot, hash: head.blockhash });
  commitIndex(
    db,
    row,
    fingerprint,
    transactions,
    transfers,
    snapshots,
    cursors,
    tokenAccounts.map((a) => a.reference),
    syncing ? "syncing" : "ready",
  );
}
