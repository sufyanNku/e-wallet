import { observedBaseOperatorFee } from "../../../packages/chain-evm/src/base-fees";
import { indexBitcoin } from "./index-bitcoin";
import { indexSolana } from "./index-solana";
import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { Interface, getAddress, keccak256 } from "ethers";
import { z } from "zod";
import { networkById } from "@ewallet/config";
import { abis } from "@ewallet/config/abis";
import { assetKey } from "@ewallet/domain";
import {
  deploymentSchema,
  type DeploymentManifest,
} from "@ewallet/domain/deployments";
import { currentEpoch } from "./environment";
import { NetworkRpcError, networkRpc } from "./node-rpc";
import { bitcoinIdentity } from "./bitcoin-rpc";
export type WatchRow = {
  id: string;
  session_id: string;
  network_id: string;
  address: string;
  descriptor_ref: string | null;
  watch_start: string;
  status: string;
  fingerprint: string | null;
};
const quantity = z.string().regex(/^0x[0-9a-f]+$/i),
  hash = z.string().regex(/^0x[0-9a-f]{64}$/i),
  address = z.string().regex(/^0x[0-9a-f]{40}$/i);
const txSchema = z.object({
  hash,
  from: address,
  to: address.nullable(),
  value: quantity,
  input: z.string(),
  nonce: quantity,
});
const blockSchema = z.object({
  number: quantity,
  hash,
  timestamp: quantity,
  transactions: z.array(txSchema),
});
const logSchema = z.object({
  address,
  topics: z.array(hash),
  data: z.string(),
  transactionHash: hash,
  logIndex: quantity,
  blockNumber: quantity,
  blockHash: hash,
  removed: z.boolean().optional(),
});
const receiptSchema = z.object({
  transactionHash: hash,
  status: quantity,
  gasUsed: quantity,
  effectiveGasPrice: quantity,
  blockNumber: quantity,
  blockHash: hash,
  l1Fee: quantity.optional(),
});
const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v));
export class PublicIndexer {
  private pending = new Map<string, Promise<void>>();
  constructor(
    readonly db: Database.Database,
    private onError: (error: unknown, row: WatchRow) => void = () => {},
  ) {}
  async close() {
    await Promise.allSettled(this.pending.values());
  }
  async fingerprint(networkId: string) {
    const profile = networkById(networkId);
    if (profile.family === "evm") {
      const id = BigInt(
        String(await networkRpc(networkId, "eth_chainId")),
      ).toString();
      if (id !== profile.identity) throw new Error("Indexed chain mismatch");
      return profile.environment === "local"
        ? (await currentEpoch(networkId)).bootEpoch
        : id;
    }
    if (profile.family === "solana") {
      const genesis = String(await networkRpc(networkId, "getGenesisHash"));
      if (profile.environment === "testnet" && genesis !== profile.identity)
        throw new Error("Indexed genesis mismatch");
      return genesis;
    }
    return (await bitcoinIdentity()).ledgerFingerprint ?? "unfunded";
  }
  async manifest(networkId: string): Promise<DeploymentManifest | null> {
    let text: string;
    try {
      text = await readFile(
        `.local/state/deployments/${networkId.replace(":", "-")}.json`,
        "utf8",
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    }
    const manifest = deploymentSchema.parse(JSON.parse(text));
    if (manifest.networkId !== networkId)
      throw new Error("Indexed manifest network mismatch");
    return manifest;
  }
  async step(row: WatchRow) {
    if (this.pending.has(row.id)) return this.pending.get(row.id)!;
    const backoff = this.db
      .prepare(
        "SELECT MAX(next_poll_at) AS next FROM sync_cursors WHERE watch_id=? AND error_code IS NOT NULL",
      )
      .get(row.id) as { next: number | null };
    if (backoff.next && backoff.next > Date.now()) return;
    const task = this.run(row)
      .catch((error) => {
        this.onError(error, row);
        this.db
          .prepare(
            "UPDATE watched_accounts SET status='unavailable' WHERE id=?",
          )
          .run(row.id);
        const prior = this.db
            .prepare(
              "SELECT MAX(failure_count) AS n FROM sync_cursors WHERE watch_id=?",
            )
            .get(row.id) as { n: number | null },
          failures = (prior.n ?? 0) + 1,
          delay = Math.min(300000, 5000 * 2 ** Math.min(failures, 6)),
          family = networkById(row.network_id).family,
          position =
            family === "evm" ? String(BigInt(row.watch_start) - 1n) : "0";
        this.db
          .prepare(
            "INSERT OR IGNORE INTO sync_cursors(watch_id,kind,position,backfill_start,next_poll_at,failure_count,error_code) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            row.id,
            family,
            position,
            row.watch_start,
            Date.now() + delay,
            0,
            "INDEX_UNAVAILABLE",
          );
        this.db
          .prepare(
            "UPDATE sync_cursors SET error_code='INDEX_UNAVAILABLE',next_poll_at=?,failure_count=? WHERE watch_id=?",
          )
          .run(Date.now() + delay, failures, row.id);
      })
      .finally(() => this.pending.delete(row.id));
    this.pending.set(row.id, task);
    return task;
  }
  private async run(row: WatchRow) {
    const fingerprint = await this.fingerprint(row.network_id);
    if (row.fingerprint !== fingerprint) {
      this.db.transaction(() => {
        if (row.fingerprint)
          this.db
            .prepare(
              "UPDATE transactions SET status='orphaned',canonical=0 WHERE network_id=? AND fingerprint=?",
            )
            .run(row.network_id, row.fingerprint);
        this.db
          .prepare("DELETE FROM sync_cursors WHERE watch_id=?")
          .run(row.id);
        this.db
          .prepare("DELETE FROM balance_snapshots WHERE watch_id=?")
          .run(row.id);
        this.db
          .prepare(
            "UPDATE watched_accounts SET fingerprint=?,status='syncing' WHERE id=?",
          )
          .run(fingerprint, row.id);
      })();
      row = { ...row, fingerprint };
    }
    const family = networkById(row.network_id).family;
    if (family === "evm") await this.evm(row, fingerprint);
    else if (family === "solana") await this.solana(row, fingerprint);
    else await this.bitcoin(row, fingerprint);
  }
  private async evm(row: WatchRow, fingerprint: string) {
    const profile = networkById(row.network_id),
      manifest = await this.manifest(row.network_id);
    if (manifest?.bootEpoch && manifest.bootEpoch !== fingerprint)
      throw new Error("Index deployment needs seed");
    const latest = BigInt(
        z.string().parse(await networkRpc(row.network_id, "eth_blockNumber")),
      ),
      start = BigInt(row.watch_start),
      cursor = this.db
        .prepare(
          "SELECT position,inclusion_hash FROM sync_cursors WHERE watch_id=? AND kind='evm'",
        )
        .get(row.id) as
        | { position: string; inclusion_hash: string | null }
        | undefined;
    let position = cursor ? BigInt(cursor.position) : start - 1n;
    if (cursor?.inclusion_hash && position >= 0n) {
      const block = (await networkRpc(row.network_id, "eth_getBlockByNumber", [
        "0x" + position.toString(16),
        false,
      ])) as { hash?: string } | null;
      if (block?.hash !== cursor.inclusion_hash) {
        // Rebuild the bounded watch range on a canonical mismatch. Atomic deletion
        // removes orphaned derived events; the transaction row remains an audit trail.
        this.db.transaction(() => {
          this.db
            .prepare(
              "UPDATE transactions SET status='orphaned',canonical=0 WHERE network_id=? AND CAST(height AS INTEGER)>=?",
            )
            .run(row.network_id, Number(start));
          this.db
            .prepare(
              "UPDATE transfers SET canonical=0 WHERE network_id=? AND tx_hash IN (SELECT hash FROM transactions WHERE network_id=? AND canonical=0)",
            )
            .run(row.network_id, row.network_id);
          this.db
            .prepare(
              "UPDATE contract_events SET canonical=0 WHERE network_id=? AND tx_hash IN (SELECT hash FROM transactions WHERE network_id=? AND canonical=0)",
            )
            .run(row.network_id, row.network_id);
          this.db
            .prepare(
              "DELETE FROM sync_cursors WHERE watch_id IN (SELECT id FROM watched_accounts WHERE network_id=?)",
            )
            .run(row.network_id);
          this.db
            .prepare(
              "UPDATE balance_snapshots SET stale=1 WHERE watch_id IN (SELECT id FROM watched_accounts WHERE network_id=?)",
            )
            .run(row.network_id);
        })();
        position = start - 1n;
      }
    }
    const end = position + 20n < latest ? position + 20n : latest;
    if (end < start) return;
    const from = position + 1n,
      logs: z.infer<typeof logSchema>[] = [],
      contracts = manifest
        ? Object.values(manifest.contracts).map((c) => c.address)
        : [];
    if (from <= end && contracts.length) {
      const result = await networkRpc(row.network_id, "eth_getLogs", [
        {
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + end.toString(16),
          address: contracts,
        },
      ]);
      logs.push(...z.array(logSchema).max(10000).parse(result));
    }
    if (manifest)
      for (const contract of Object.values(manifest.contracts)) {
        const code = z
          .string()
          .parse(
            await networkRpc(row.network_id, "eth_getCode", [
              contract.address,
              "latest",
            ]),
          );
        if (code === "0x" || keccak256(code) !== contract.codeHash)
          throw new Error("Indexed contract code differs from manifest");
      }
    const target = getAddress(row.address).toLowerCase(),
      transactions: Array<Record<string, unknown>> = [],
      transfers: Array<Record<string, unknown>> = [],
      events: Array<Record<string, unknown>> = [],
      relevant = new Set<string>(),
      blocks = new Map<string, z.infer<typeof blockSchema>>();
    const assetRows: Array<{
      key: string;
      networkId: string;
      standard: string;
      reference: string;
      tokenId: string;
      decimals: number;
      symbol: string;
      name: string;
    }> = [];
    const addAsset = (
      standard: string,
      reference: string,
      tokenId: string,
      decimals: number,
      symbol: string,
      name: string,
    ) => {
      const key = assetKey({
        networkId: row.network_id,
        standard: standard as "native" | "erc20" | "erc721" | "erc1155",
        reference: reference.toLowerCase(),
        ...(tokenId ? { tokenId } : {}),
      });
      assetRows.push({
        key,
        networkId: row.network_id,
        standard,
        reference: reference.toLowerCase(),
        tokenId,
        decimals,
        symbol,
        name,
      });
      return key;
    };
    const nativeKey = addAsset(
      "native",
      "native",
      "",
      profile.feeAsset.decimals,
      profile.feeAsset.symbol,
      profile.name,
    );
    for (const log of logs) {
      if (log.removed) continue;
      const entry = manifest?.assets.find(
          (a) => a.reference.toLowerCase() === log.address.toLowerCase(),
        ),
        contractEntry = Object.entries(manifest?.contracts ?? {}).find(
          ([, c]) => c.address.toLowerCase() === log.address.toLowerCase(),
        );
      if (!contractEntry) throw new Error("Unexpected indexed log source");
      const abi =
        entry?.standard === "erc20"
          ? abis.DemoERC20
          : entry?.standard === "erc721"
            ? abis.DemoNFT721
            : entry?.standard === "erc1155"
              ? abis.DemoNFT1155
              : abis[contractEntry[0] as keyof typeof abis];
      if (!abi) continue;
      const decoded = new Interface(abi).parseLog(log);
      if (!decoded) continue;
      const eventIndex = String(BigInt(log.logIndex)),
        participants: string[] = [];
      const transfer = (
        from: string,
        to: string,
        amount: bigint,
        tokenId = "",
        suffix = "",
      ) => {
        participants.push(from.toLowerCase(), to.toLowerCase());
        const key = addAsset(
          entry!.standard,
          entry!.reference,
          tokenId,
          entry!.decimals,
          entry!.symbol,
          entry!.name,
        );
        transfers.push({
          hash: log.transactionHash,
          index: eventIndex + suffix,
          key,
          amount: String(amount),
          from: from.toLowerCase(),
          to: to.toLowerCase(),
          data: json({ standard: entry!.standard, tokenId }),
        });
      };
      if (entry && decoded.name === "Transfer")
        transfer(
          String(decoded.args[0]),
          String(decoded.args[1]),
          entry.standard === "erc721" ? 1n : BigInt(decoded.args[2]),
          entry.standard === "erc721" ? String(decoded.args[2]) : "",
        );
      else if (entry && decoded.name === "TransferSingle")
        transfer(
          String(decoded.args[1]),
          String(decoded.args[2]),
          BigInt(decoded.args[4]),
          String(decoded.args[3]),
        );
      else if (entry && decoded.name === "TransferBatch") {
        for (let i = 0; i < decoded.args[3].length; i++)
          transfer(
            String(decoded.args[1]),
            String(decoded.args[2]),
            BigInt(decoded.args[4][i]),
            String(decoded.args[3][i]),
            ":" + i,
          );
      } else {
        relevant.add(log.transactionHash);
        events.push({
          address: log.address.toLowerCase(),
          hash: log.transactionHash,
          index: eventIndex,
          name: decoded.name,
          payload: json(
            Object.fromEntries(
              decoded.fragment.inputs.map((input, i) => [
                input.name || String(i),
                decoded.args[i],
              ]),
            ),
          ),
        });
      }
      if (participants.includes(target)) relevant.add(log.transactionHash);
    }
    let endHash = cursor?.inclusion_hash ?? null;
    for (let height = from; height <= end; height++) {
      const block = blockSchema.parse(
        await networkRpc(row.network_id, "eth_getBlockByNumber", [
          "0x" + height.toString(16),
          true,
        ]),
      );
      blocks.set(String(height), block);
      endHash = block.hash;
      for (const transaction of block.transactions) {
        if (
          transaction.from.toLowerCase() === target ||
          transaction.to?.toLowerCase() === target
        )
          relevant.add(transaction.hash);
      }
    }
    for (const block of blocks.values())
      for (const transaction of block.transactions) {
        if (!relevant.has(transaction.hash)) continue;
        const receipt = receiptSchema.parse(
          await networkRpc(row.network_id, "eth_getTransactionReceipt", [
            transaction.hash,
          ]),
        );
        if (receipt.blockHash !== block.hash)
          throw new Error("Indexed inclusion changed during batch");
        const confirmations = latest - BigInt(block.number) + 1n,
          state =
            BigInt(receipt.status) === 0n
              ? "reverted"
              : confirmations >= BigInt(profile.finality.confirmations)
                ? "confirmed"
                : "included";
        const fee =
          BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) +
          BigInt(receipt.l1Fee ?? "0x0") +
          (row.network_id === "eip155:84532"
            ? await observedBaseOperatorFee(
                {
                  send: (method, params) =>
                    networkRpc(row.network_id, method, params),
                },
                BigInt(receipt.gasUsed),
                receipt.blockNumber,
              )
            : 0n);
        transactions.push({
          network: row.network_id,
          hash: transaction.hash,
          height: String(BigInt(block.number)),
          blockHash: block.hash,
          state,
          from: transaction.from.toLowerCase(),
          to: transaction.to?.toLowerCase() ?? null,
          fee: String(fee),
          createdAt: new Date(
            Number(BigInt(block.timestamp)) * 1000,
          ).toISOString(),
          value: String(BigInt(transaction.value)),
          data: json({
            input: transaction.input,
            nonce: String(BigInt(transaction.nonce)),
            coverage:
              "Outer native transfers and registered contract events; internal native trace coverage is incomplete.",
          }),
        });
        if (
          (state === "reverted" || BigInt(transaction.value) === 0n) &&
          !transfers.some((t) => t.hash === transaction.hash)
        )
          transfers.push({
            hash: transaction.hash,
            index: "operation",
            key: nativeKey,
            amount: "0",
            from: transaction.from.toLowerCase(),
            to: transaction.to?.toLowerCase() ?? null,
            data: json({ operation: true, reverted: state === "reverted" }),
          });
        if (
          state !== "reverted" &&
          BigInt(transaction.value) > 0n &&
          transaction.to
        )
          transfers.push({
            hash: transaction.hash,
            index: "native",
            key: nativeKey,
            amount: String(BigInt(transaction.value)),
            from: transaction.from.toLowerCase(),
            to: transaction.to.toLowerCase(),
            data: "{}",
          });
      }
    // Only transfers whose receipt belongs to this coherent batch are committed.
    const committed = new Set(transactions.map((t) => String(t.hash)));
    const snapshotAssets = [
      ...new Map(assetRows.map((a) => [a.key, a])).values(),
    ];
    if (manifest)
      for (const a of manifest.assets)
        for (const tokenId of a.standard === "erc20"
          ? [""]
          : (a.tokenIds ?? [])) {
          const key = addAsset(
            a.standard,
            a.reference,
            tokenId,
            a.decimals,
            a.symbol,
            a.name,
          );
          if (!snapshotAssets.some((s) => s.key === key))
            snapshotAssets.push(assetRows.at(-1)!);
        }
    const balanceSnapshots: Array<{ key: string; amount: string }> = [];
    const snapshotBlock = "0x" + end.toString(16),
      codeAt = new Map<string, string>();
    for (const a of snapshotAssets) {
      let amount = 0n;
      if (a.standard === "native")
        amount = BigInt(
          String(
            await networkRpc(row.network_id, "eth_getBalance", [
              target,
              snapshotBlock,
            ]),
          ),
        );
      else {
        let code = codeAt.get(a.reference);
        if (code === undefined) {
          code = String(
            await networkRpc(row.network_id, "eth_getCode", [
              a.reference,
              snapshotBlock,
            ]),
          );
          codeAt.set(a.reference, code);
        }
        if (code !== "0x") {
          const iface = new Interface(
              a.standard === "erc20"
                ? abis.DemoERC20
                : a.standard === "erc721"
                  ? abis.DemoNFT721
                  : abis.DemoNFT1155,
            ),
            method = a.standard === "erc721" ? "ownerOf" : "balanceOf",
            args =
              a.standard === "erc721"
                ? [a.tokenId]
                : a.standard === "erc1155"
                  ? [target, a.tokenId]
                  : [target];
          try {
            const result = String(
                await networkRpc(row.network_id, "eth_call", [
                  {
                    to: a.reference,
                    data: iface.encodeFunctionData(method, args),
                  },
                  snapshotBlock,
                ]),
              ),
              decoded = iface.decodeFunctionResult(method, result)[0];
            amount =
              a.standard === "erc721"
                ? String(decoded).toLowerCase() === target
                  ? 1n
                  : 0n
                : BigInt(decoded);
          } catch (error) {
            if (
              !(
                a.standard === "erc721" &&
                error instanceof NetworkRpcError &&
                error.executionReverted
              )
            )
              throw error;
          }
        }
      }
      balanceSnapshots.push({ key: a.key, amount: String(amount) });
    }
    const now = new Date().toISOString();
    if (
      endHash &&
      (
        (await networkRpc(row.network_id, "eth_getBlockByNumber", [
          "0x" + end.toString(16),
          false,
        ])) as { hash: string }
      ).hash !== endHash
    )
      throw new Error("Indexed head reorged before commit");
    this.db.transaction(() => {
      for (const asset of assetRows)
        this.db
          .prepare(
            "INSERT INTO assets(asset_key,network_id,standard,reference,token_id,decimals,symbol,name) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(asset_key) DO UPDATE SET decimals=excluded.decimals,symbol=excluded.symbol,name=excluded.name",
          )
          .run(
            asset.key,
            asset.networkId,
            asset.standard,
            asset.reference,
            asset.tokenId,
            asset.decimals,
            asset.symbol,
            asset.name,
          );
      for (const t of transactions)
        this.db
          .prepare(
            "INSERT INTO transactions(network_id,hash,height,block_hash,status,from_address,to_address,fee,created_at,value,data_json,canonical,last_observed_at,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(network_id,hash) DO UPDATE SET height=excluded.height,block_hash=excluded.block_hash,status=excluded.status,fee=excluded.fee,data_json=excluded.data_json,canonical=1,last_observed_at=excluded.last_observed_at,fingerprint=excluded.fingerprint",
          )
          .run(
            t.network,
            t.hash,
            t.height,
            t.blockHash,
            t.state,
            t.from,
            t.to,
            t.fee,
            t.createdAt,
            t.value,
            t.data,
            now,
            fingerprint,
          );
      for (const t of transfers)
        if (committed.has(String(t.hash)))
          this.db
            .prepare(
              "INSERT INTO transfers(network_id,tx_hash,event_index,asset_key,amount,from_address,to_address,canonical,data_json) VALUES (?,?,?,?,?,?,?,1,?) ON CONFLICT(network_id,tx_hash,event_index) DO UPDATE SET canonical=1,amount=excluded.amount",
            )
            .run(
              row.network_id,
              t.hash,
              t.index,
              t.key,
              t.amount,
              t.from,
              t.to,
              t.data,
            );
      for (const e of events)
        if (committed.has(String(e.hash)))
          this.db
            .prepare(
              "INSERT INTO contract_events(network_id,contract_address,tx_hash,event_index,event_name,payload_json,canonical) VALUES (?,?,?,?,?,?,1) ON CONFLICT(network_id,tx_hash,event_index) DO UPDATE SET canonical=1,payload_json=excluded.payload_json",
            )
            .run(row.network_id, e.address, e.hash, e.index, e.name, e.payload);
      for (const t of transfers)
        if (
          committed.has(String(t.hash)) &&
          (t.from === target || t.to === target)
        )
          this.db
            .prepare(
              "INSERT OR IGNORE INTO watch_transactions(watch_id,network_id,tx_hash,event_index,direction) VALUES (?,?,?,?,?)",
            )
            .run(
              row.id,
              row.network_id,
              t.hash,
              t.index,
              t.from === target && t.to === target
                ? "self"
                : t.from === target
                  ? "outgoing"
                  : "incoming",
            );
      for (const snapshot of balanceSnapshots)
        this.db
          .prepare(
            "INSERT INTO balance_snapshots(watch_id,asset_key,height,block_hash,amount,observed_at,stale) VALUES (?,?,?,?,?,?,0) ON CONFLICT(watch_id,asset_key,height) DO UPDATE SET amount=excluded.amount,block_hash=excluded.block_hash,observed_at=excluded.observed_at,stale=0",
          )
          .run(
            row.id,
            snapshot.key,
            String(end),
            endHash,
            snapshot.amount,
            now,
          );
      this.db
        .prepare(
          "INSERT INTO sync_cursors(watch_id,kind,position,inclusion_hash,backfill_start,last_synced_at,next_poll_at) VALUES (?,'evm',?,?,?,?,?) ON CONFLICT(watch_id,kind) DO UPDATE SET position=excluded.position,inclusion_hash=excluded.inclusion_hash,last_synced_at=excluded.last_synced_at,error_code=NULL,failure_count=0,next_poll_at=excluded.next_poll_at",
        )
        .run(
          row.id,
          String(end),
          endHash,
          String(start),
          now,
          Date.now() + 5000,
        );
      this.db
        .prepare(
          "UPDATE transactions SET status='confirmed' WHERE network_id=? AND canonical=1 AND status='included' AND CAST(height AS INTEGER)<=?",
        )
        .run(
          row.network_id,
          Number(latest - BigInt(profile.finality.confirmations) + 1n),
        );
      this.db
        .prepare("UPDATE watched_accounts SET status=? WHERE id=?")
        .run(end >= latest ? "ready" : "syncing", row.id);
    })();
  }
  private async solana(row: WatchRow, fingerprint: string) {
    await indexSolana(this.db, row, fingerprint);
  }
  private async bitcoin(row: WatchRow, fingerprint: string) {
    await indexBitcoin(this.db, row, fingerprint);
  }
}
