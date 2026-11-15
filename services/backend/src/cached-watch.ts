import type Database from "better-sqlite3";
// Reattaching a public address must not lose already observed history when a
// node prunes old receipts. This shares public events, never another watch ID.
export function linkCachedActivity(
  db: Database.Database,
  watchId: string,
  networkId: string,
  address: string,
  fingerprint: string,
  start: string,
) {
  db.prepare(
    `INSERT OR IGNORE INTO watch_transactions(watch_id,network_id,tx_hash,event_index,direction) SELECT ?,f.network_id,f.tx_hash,f.event_index,CASE WHEN f.from_address=? AND f.to_address=? THEN 'self' WHEN f.from_address=? THEN 'outgoing' ELSE 'incoming' END FROM transfers f JOIN transactions t ON t.network_id=f.network_id AND t.hash=f.tx_hash WHERE f.network_id=? AND t.fingerprint=? AND t.canonical=1 AND f.canonical=1 AND (f.from_address=? OR f.to_address=?) AND CAST(t.height AS INTEGER)>=? LIMIT 10000`,
  ).run(
    watchId,
    address,
    address,
    address,
    networkId,
    fingerprint,
    address,
    address,
    Number(start),
  );
}
