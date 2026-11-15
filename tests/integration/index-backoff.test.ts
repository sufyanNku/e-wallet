import { it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../../services/backend/src/migrations";
import {
  PublicIndexer,
  type WatchRow,
} from "../../services/backend/src/public-indexer";
it("durably backs off repeated upstream failures and skips premature foreground retries", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const indexer = new PublicIndexer(db),
    rpc = vi
      .spyOn(indexer, "fingerprint")
      .mockRejectedValue(new Error("Controlled rate-limit fixture")),
    row: WatchRow = {
      id: crypto.randomUUID(),
      session_id: "fixture",
      network_id: "eip155:31337",
      address: "0x1111111111111111111111111111111111111111",
      watch_start: "1",
      status: "syncing",
      fingerprint: null,
      descriptor_ref: null,
    };
  db.prepare(
    "INSERT INTO sessions(id,csrf_hash,expires_at) VALUES (?,?,?)",
  ).run("fixture", "test", Date.now() + 600000);
  db.prepare(
    "INSERT INTO watched_accounts(id,session_id,network_id,address,watch_start,status,added_at) VALUES (?,?,?,?,?,?,?)",
  ).run(
    row.id,
    row.session_id,
    row.network_id,
    row.address,
    row.watch_start,
    row.status,
    new Date().toISOString(),
  );
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    await indexer.step(row);
    let cursor = db
      .prepare(
        "SELECT failure_count,next_poll_at FROM sync_cursors WHERE watch_id=?",
      )
      .get(row.id) as { failure_count: number; next_poll_at: number };
    expect(cursor.failure_count).toBe(1);
    expect(cursor.next_poll_at - now).toBe(10000);
    await indexer.step(row);
    expect(rpc).toHaveBeenCalledTimes(1);
    now += 10001;
    await indexer.step(row);
    cursor = db
      .prepare(
        "SELECT failure_count,next_poll_at FROM sync_cursors WHERE watch_id=?",
      )
      .get(row.id) as typeof cursor;
    expect(cursor.failure_count).toBe(2);
    expect(cursor.next_poll_at - now).toBe(20000);
    expect(rpc).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    await indexer.close();
    db.close();
  }
});
