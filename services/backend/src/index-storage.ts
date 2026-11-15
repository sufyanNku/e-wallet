import type Database from "better-sqlite3";
import { assetKey, type AssetId } from "@ewallet/domain";
import type { WatchRow } from "./public-indexer";
export type IndexedAsset = {
  asset: AssetId;
  decimals: number;
  symbol: string;
  name: string;
};
export type IndexedTransaction = {
  hash: string;
  height: string;
  blockHash: string | null;
  state: string;
  from: string | null;
  to: string | null;
  fee: string | null;
  createdAt: string;
  value: string;
  data: unknown;
};
export type IndexedTransfer = {
  hash: string;
  index: string;
  asset: IndexedAsset;
  amount: string;
  from: string | null;
  to: string | null;
  direction: "incoming" | "outgoing" | "self";
  data?: unknown;
};
const json = (v: unknown) =>
  JSON.stringify(v, (_, value) =>
    typeof value === "bigint" ? String(value) : value,
  );
export function commitIndex(
  db: Database.Database,
  row: WatchRow,
  fingerprint: string,
  transactions: IndexedTransaction[],
  transfers: IndexedTransfer[],
  snapshots: Array<{
    asset: IndexedAsset;
    height: string;
    blockHash: string | null;
    amount: string;
  }>,
  cursors: Array<{ kind: string; position: string; hash: string | null }>,
  subaccounts: string[] = [],
  status = "ready",
) {
  const now = new Date().toISOString();
  db.transaction(() => {
    const assets = [
      ...transfers.map((t) => t.asset),
      ...snapshots.map((s) => s.asset),
    ];
    for (const a of assets)
      db.prepare(
        "INSERT INTO assets(asset_key,network_id,standard,reference,token_id,decimals,symbol,name) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(asset_key) DO UPDATE SET decimals=excluded.decimals,symbol=excluded.symbol,name=excluded.name",
      ).run(
        assetKey(a.asset),
        row.network_id,
        a.asset.standard,
        a.asset.reference,
        a.asset.tokenId ?? "",
        a.decimals,
        a.symbol,
        a.name,
      );
    for (const t of transactions)
      db.prepare(
        "INSERT INTO transactions(network_id,hash,height,block_hash,status,from_address,to_address,fee,created_at,value,data_json,canonical,last_observed_at,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(network_id,hash) DO UPDATE SET height=excluded.height,block_hash=excluded.block_hash,status=excluded.status,fee=excluded.fee,data_json=excluded.data_json,canonical=1,last_observed_at=excluded.last_observed_at,fingerprint=excluded.fingerprint",
      ).run(
        row.network_id,
        t.hash,
        t.height,
        t.blockHash,
        t.state,
        t.from,
        t.to,
        t.fee,
        t.createdAt,
        t.value,
        json(t.data),
        now,
        fingerprint,
      );
    for (const t of transfers) {
      db.prepare(
        "INSERT INTO transfers(network_id,tx_hash,event_index,asset_key,amount,from_address,to_address,canonical,data_json) VALUES (?,?,?,?,?,?,?,1,?) ON CONFLICT(network_id,tx_hash,event_index) DO UPDATE SET canonical=1,amount=excluded.amount,from_address=excluded.from_address,to_address=excluded.to_address",
      ).run(
        row.network_id,
        t.hash,
        t.index,
        assetKey(t.asset.asset),
        t.amount,
        t.from,
        t.to,
        json(t.data ?? {}),
      );
      db.prepare(
        "INSERT OR IGNORE INTO watch_transactions(watch_id,network_id,tx_hash,event_index,direction) VALUES (?,?,?,?,?)",
      ).run(row.id, row.network_id, t.hash, t.index, t.direction);
    }
    for (const s of snapshots)
      db.prepare(
        "INSERT INTO balance_snapshots(watch_id,asset_key,height,block_hash,amount,observed_at,stale) VALUES (?,?,?,?,?,?,0) ON CONFLICT(watch_id,asset_key,height) DO UPDATE SET amount=excluded.amount,block_hash=excluded.block_hash,observed_at=excluded.observed_at,stale=0",
      ).run(
        row.id,
        assetKey(s.asset.asset),
        s.height,
        s.blockHash,
        s.amount,
        now,
      );
    for (const c of cursors)
      db.prepare(
        "INSERT INTO sync_cursors(watch_id,kind,position,inclusion_hash,backfill_start,last_synced_at,error_code,next_poll_at) VALUES (?,?,?,?,?,?,NULL,?) ON CONFLICT(watch_id,kind) DO UPDATE SET position=excluded.position,inclusion_hash=excluded.inclusion_hash,last_synced_at=excluded.last_synced_at,error_code=NULL,failure_count=0,next_poll_at=excluded.next_poll_at",
      ).run(
        row.id,
        c.kind,
        c.position,
        c.hash,
        row.watch_start,
        now,
        Date.now() + 5000,
      );
    for (const address of subaccounts)
      db.prepare(
        "INSERT OR IGNORE INTO watched_subaccounts(watch_id,address,kind,first_observed_at) VALUES (?,?,?,?)",
      ).run(row.id, address, "token-account", now);
    db.prepare("UPDATE watched_accounts SET status=? WHERE id=?").run(
      status,
      row.id,
    );
  })();
}
export function orphanFrom(
  db: Database.Database,
  row: WatchRow,
  height: string,
) {
  db.transaction(() => {
    db.prepare(
      "UPDATE transactions SET canonical=0,status='orphaned' WHERE network_id=? AND fingerprint=? AND CAST(height AS INTEGER)>=?",
    ).run(row.network_id, row.fingerprint, Number(height));
    db.prepare(
      "UPDATE transfers SET canonical=0 WHERE network_id=? AND tx_hash IN (SELECT hash FROM transactions WHERE network_id=? AND canonical=0)",
    ).run(row.network_id, row.network_id);
    db.prepare("UPDATE balance_snapshots SET stale=1 WHERE watch_id=?").run(
      row.id,
    );
  })();
}
