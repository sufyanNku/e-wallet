import type Database from "better-sqlite3";
import { z } from "zod";
import {
  bitcoin,
  satoshis,
  deriveWatchAddress,
  validateWatch,
  type BitcoinWatch,
} from "@ewallet/chain-bitcoin";
import { bitcoinRpc, bitcoinIdentity } from "./bitcoin-rpc";
import {
  commitIndex,
  orphanFrom,
  type IndexedTransaction,
  type IndexedTransfer,
  type IndexedAsset,
} from "./index-storage";
import type { WatchRow } from "./public-indexer";
const amount = z.string(),
  raw = z.string().regex(/^[0-9]+$/);
const txSchema = z.object({
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  hex: z.string(),
  blockhash: z.string().optional(),
  blocktime: raw.optional(),
  confirmations: z.string().optional(),
  vin: z.array(
    z.object({
      txid: z.string().optional(),
      vout: raw.optional(),
      coinbase: z.string().optional(),
    }),
  ),
  vout: z.array(
    z.object({
      value: amount,
      n: raw,
      scriptPubKey: z.object({
        hex: z.string(),
        address: z.string().optional(),
      }),
    }),
  ),
});
const cache = new Map<
  string,
  Map<string, ReturnType<typeof deriveWatchAddress>>
>();
function scripts(watch: BitcoinWatch) {
  const key = JSON.stringify(watch);
  let map = cache.get(key);
  if (!map) {
    map = new Map();
    for (const branch of [0, 1] as const)
      for (let i = 0; i < 1000; i++) {
        const derived = deriveWatchAddress(watch, branch, i);
        map.set(derived.scriptHex, derived);
      }
    if (cache.size >= 20) cache.delete(cache.keys().next().value!);
    cache.set(key, map);
  }
  return map;
}
export async function indexBitcoin(
  db: Database.Database,
  row: WatchRow,
  fingerprint: string,
) {
  if (!row.descriptor_ref)
    throw new Error(
      "Bitcoin history requires the consented public descriptor watch.",
    );
  const owned = db
    .prepare(
      "SELECT a.public_json FROM btc_sessions s JOIN btc_accounts a ON a.id=s.account_id WHERE s.watch_id=? AND s.session_id=?",
    )
    .get(row.descriptor_ref, row.session_id) as
    | { public_json: string }
    | undefined;
  if (!owned)
    throw new Error("Descriptor watch is not scoped to the indexed session");
  const watch = validateWatch(JSON.parse(owned.public_json)),
    known = scripts(watch),
    identity = await bitcoinIdentity();
  if (identity.ledgerFingerprint !== fingerprint)
    throw new Error("Regtest ledger changed before indexing");
  const history = z
    .array(
      z.object({
        txid: z.string(),
        confirmations: z.string().optional(),
        abandoned: z.boolean().optional(),
      }),
    )
    .parse(
      await bitcoinRpc(
        "listtransactions",
        ["*", 1000, 0, true],
        "ewallet-watch",
      ),
    );
  if (history.length >= 1000)
    throw new Error(
      "Wallet history exceeds the bounded 1,000-entry view; rescan a narrower range.",
    );
  const txs: IndexedTransaction[] = [],
    transfers: IndexedTransfer[] = [],
    asset: IndexedAsset = {
      asset: {
        networkId: row.network_id,
        standard: "native",
        reference: "native",
      },
      decimals: 8,
      symbol: "BTC",
      name: "Bitcoin Regtest",
    };
  for (const txid of new Set(history.map((t) => t.txid))) {
    const rawTx = txSchema.parse(
        await bitcoinRpc("getrawtransaction", [txid, true]),
      ),
      decoded = bitcoin.Transaction.fromHex(rawTx.hex);
    if (decoded.getId() !== txid)
      throw new Error("Bitcoin transaction identifier mismatch");
    const inputs: Array<{
      value: bigint;
      script: string;
      address: string | null;
      owned: boolean;
    }> = [];
    let coinbase = false;
    for (const input of rawTx.vin) {
      if (input.coinbase) {
        coinbase = true;
        continue;
      }
      if (input.txid === undefined || input.vout === undefined)
        throw new Error("Missing referenced Bitcoin input");
      const previous = txSchema.parse(
          await bitcoinRpc("getrawtransaction", [input.txid, true]),
        ),
        output = previous.vout[Number(input.vout)];
      if (!output) throw new Error("Referenced Bitcoin output missing");
      inputs.push({
        value: BigInt(satoshis(output.value)),
        script: output.scriptPubKey.hex,
        address: output.scriptPubKey.address ?? null,
        owned: known.has(output.scriptPubKey.hex),
      });
    }
    const ours = inputs.some((i) => i.owned),
      received = rawTx.vout.some((o) => known.has(o.scriptPubKey.hex));
    if (!ours && !received) continue;
    let height = "0",
      blockHash: string | null = null,
      state = "submitted";
    if (rawTx.blockhash) {
      const block = z
        .object({ height: raw, confirmations: z.string() })
        .parse(await bitcoinRpc("getblockheader", [rawTx.blockhash, true]));
      height = block.height;
      blockHash = rawTx.blockhash;
      if (BigInt(block.confirmations) < 0n) {
        orphanFrom(db, row, height);
        continue;
      }
      const confirmations = BigInt(rawTx.confirmations ?? "0");
      state =
        confirmations >= 6n
          ? "confirmed"
          : confirmations >= 1n
            ? "included"
            : "submitted";
    }
    const valueOut = rawTx.vout.reduce(
        (sum, o) => sum + BigInt(satoshis(o.value)),
        0n,
      ),
      valueIn = inputs.reduce((sum, i) => sum + i.value, 0n),
      fee = coinbase ? null : String(valueIn - valueOut);
    if (fee !== null && BigInt(fee) < 0n)
      throw new Error("Bitcoin fee arithmetic is negative");
    txs.push({
      hash: txid,
      height,
      blockHash,
      state,
      from: inputs.find((i) => i.owned)?.address ?? inputs[0]?.address ?? null,
      to:
        rawTx.vout.find((o) => !known.has(o.scriptPubKey.hex))?.scriptPubKey
          .address ?? null,
      fee,
      createdAt: rawTx.blocktime
        ? new Date(Number(rawTx.blocktime) * 1000).toISOString()
        : new Date().toISOString(),
      value: String(valueOut),
      data: {
        virtualSize: decoded.virtualSize(),
        ownInputs: inputs.filter((i) => i.owned).length,
        observedChange: rawTx.vout
          .filter((o) => known.get(o.scriptPubKey.hex)?.change === 1)
          .map((o) => ({
            address: o.scriptPubKey.address,
            value: satoshis(o.value),
          })),
        confirmationPolicy:
          "One confirmation included; six local completion threshold.",
      },
    });
    for (const output of rawTx.vout) {
      const derived = known.get(output.scriptPubKey.hex);
      if (ours) {
        if (derived) continue;
        transfers.push({
          hash: txid,
          index: "output:" + output.n,
          asset,
          amount: satoshis(output.value),
          from: inputs.find((i) => i.owned)?.address ?? null,
          to: output.scriptPubKey.address ?? null,
          direction: "outgoing",
          data: { change: false },
        });
      } else if (derived)
        transfers.push({
          hash: txid,
          index: "output:" + output.n,
          asset,
          amount: satoshis(output.value),
          from: inputs[0]?.address ?? null,
          to: derived.address,
          direction: "incoming",
          data: { change: derived.change === 1 },
        });
    }
    if (ours && !transfers.some((t) => t.hash === txid))
      transfers.push({
        hash: txid,
        index: "self",
        asset,
        amount: String(
          rawTx.vout
            .filter((o) => known.has(o.scriptPubKey.hex))
            .reduce((sum, o) => sum + BigInt(satoshis(o.value)), 0n),
        ),
        from: inputs.find((i) => i.owned)?.address ?? null,
        to: row.address,
        direction: "self",
        data: { feeOnlySelfTransfer: true },
      });
  }
  const unspent = z
      .array(z.object({ scriptPubKey: z.string(), amount, confirmations: raw }))
      .parse(
        await bitcoinRpc(
          "listunspent",
          [0, 9999999, [], true],
          "ewallet-watch",
        ),
      ),
    balance = unspent
      .filter((u) => known.has(u.scriptPubKey))
      .reduce((sum, u) => sum + BigInt(satoshis(u.amount)), 0n),
    current = await bitcoinIdentity();
  if (current.bestblockhash !== identity.bestblockhash)
    throw new Error("Regtest head changed before index commit");
  commitIndex(
    db,
    row,
    fingerprint,
    txs,
    transfers,
    [
      {
        asset,
        height: identity.blocks,
        blockHash: identity.bestblockhash,
        amount: String(balance),
      },
    ],
    [
      {
        kind: "bitcoin",
        position: identity.blocks,
        hash: identity.bestblockhash,
      },
    ],
  );
}
