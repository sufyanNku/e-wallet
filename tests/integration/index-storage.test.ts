import { linkCachedActivity } from "../../services/backend/src/cached-watch";
import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../../services/backend/src/migrations";
import {
  commitIndex,
  orphanFrom,
  type IndexedAsset,
} from "../../services/backend/src/index-storage";
import type { WatchRow } from "../../services/backend/src/public-indexer";
it("migrates idempotently and commits event deduplication, watch isolation and cursor updates atomically", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  migrate(db);
  migrate(db);
  expect(
    (
      db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as {
        n: number;
      }
    ).n,
  ).toBe(7);
  db.prepare(
    "INSERT INTO sessions(id,csrf_hash,expires_at) VALUES (?,?,?)",
  ).run("alice", "hash", Date.now() + 60000);
  db.prepare(
    "INSERT INTO sessions(id,csrf_hash,expires_at) VALUES (?,?,?)",
  ).run("bob", "hash", Date.now() + 60000);
  const row: WatchRow = {
    id: crypto.randomUUID(),
    session_id: "alice",
    network_id: "solana:local",
    address: "owner",
    descriptor_ref: null,
    watch_start: "0",
    status: "syncing",
    fingerprint: "genesis",
  };
  db.prepare(
    "INSERT INTO watched_accounts(id,session_id,network_id,address,watch_start,status,added_at,fingerprint) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    row.id,
    row.session_id,
    row.network_id,
    row.address,
    "0",
    "syncing",
    new Date().toISOString(),
    "genesis",
  );
  const asset: IndexedAsset = {
      asset: {
        networkId: row.network_id,
        standard: "native",
        reference: "native",
      },
      decimals: 9,
      symbol: "SOL",
      name: "Solana",
    },
    transaction = {
      hash: "synthetic-public-index-fixture",
      height: "10",
      blockHash: "block-a",
      state: "confirmed",
      from: "sender",
      to: "owner",
      fee: "5000",
      createdAt: new Date().toISOString(),
      value: "1",
      data: { fixture: true },
    },
    transfer = {
      hash: transaction.hash,
      index: "outer:0",
      asset,
      amount: "1",
      from: "sender",
      to: "owner",
      direction: "incoming" as const,
    };
  for (let i = 0; i < 2; i++)
    commitIndex(
      db,
      row,
      "genesis",
      [transaction],
      [transfer],
      [{ asset, height: "10", blockHash: "block-a", amount: "1" }],
      [{ kind: "solana", position: "10", hash: "block-a" }],
    );
  expect(
    (db.prepare("SELECT count(*) AS n FROM transfers").get() as { n: number })
      .n,
  ).toBe(1);
  expect(
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM watch_transactions WHERE watch_id=?",
        )
        .get(row.id) as { n: number }
    ).n,
  ).toBe(1);
  expect(
    db
      .prepare("SELECT id FROM watched_accounts WHERE id=? AND session_id=?")
      .get(row.id, "bob"),
  ).toBeUndefined();
  const restoredId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO watched_accounts(id,session_id,network_id,address,watch_start,status,added_at,fingerprint) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    restoredId,
    "bob",
    row.network_id,
    row.address,
    "10",
    "ready",
    new Date().toISOString(),
    "genesis",
  );
  linkCachedActivity(
    db,
    restoredId,
    row.network_id,
    row.address,
    "genesis",
    "10",
  );
  expect(
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM watch_transactions WHERE watch_id=?",
        )
        .get(restoredId) as { n: number }
    ).n,
  ).toBe(1);
  orphanFrom(db, row, "10");
  expect(
    (db.prepare("SELECT status FROM transactions").get() as { status: string })
      .status,
  ).toBe("orphaned");
  expect(
    (
      db
        .prepare("SELECT count(*) AS n FROM transfers WHERE canonical=1")
        .get() as { n: number }
    ).n,
  ).toBe(0);
  expect(
    (
      db.prepare("SELECT count(*) AS n FROM watch_transactions").get() as {
        n: number;
      }
    ).n,
  ).toBe(2);
  commitIndex(
    db,
    row,
    "genesis",
    [{ ...transaction, blockHash: "block-b" }],
    [transfer],
    [],
    [{ kind: "solana", position: "10", hash: "block-b" }],
  );
  expect(
    (
      db.prepare("SELECT canonical FROM transactions").get() as {
        canonical: number;
      }
    ).canonical,
  ).toBe(1);
  db.close();
});
