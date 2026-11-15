import { it, expect, vi } from "vitest";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { migrate } from "../../services/backend/src/migrations";
import { registerWatchApi } from "../../services/backend/src/watch-api";
import { registerReadApi } from "../../services/backend/src/read-api";
import { commitIndex } from "../../services/backend/src/index-storage";
import type { WatchRow } from "../../services/backend/src/public-indexer";
it("serves lossless session-scoped balances, stable cursor pages, details and transition notifications without repeats", async () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  migrate(db);
  const app = Fastify(),
    session = (req: { headers: Record<string, unknown> }) => ({
      id: String(req.headers["x-test-session"] ?? ""),
    });
  const indexer = await registerWatchApi(app, db, session);
  vi.spyOn(indexer, "step").mockResolvedValue();
  registerReadApi(app, db, session, indexer);
  for (const id of ["alice", "bob"])
    db.prepare(
      "INSERT INTO sessions(id,csrf_hash,expires_at) VALUES (?,?,?)",
    ).run(id, "test", Date.now() + 600000);
  const row: WatchRow = {
    id: randomUUID(),
    session_id: "alice",
    network_id: "eip155:31337",
    address: "0x1111111111111111111111111111111111111111",
    descriptor_ref: null,
    watch_start: "10",
    status: "ready",
    fingerprint: "epoch",
  };
  db.prepare(
    "INSERT INTO watched_accounts(id,session_id,network_id,address,watch_start,status,added_at,fingerprint) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    row.id,
    row.session_id,
    row.network_id,
    row.address,
    row.watch_start,
    row.status,
    new Date().toISOString(),
    row.fingerprint,
  );
  const asset = {
    asset: {
      networkId: row.network_id,
      standard: "native" as const,
      reference: "native",
    },
    decimals: 18,
    symbol: "ETH",
    name: "Local Ethereum",
  };
  for (let i = 0; i < 3; i++) {
    const hash = "0x" + String(i + 1).repeat(64);
    commitIndex(
      db,
      row,
      "epoch",
      [
        {
          hash,
          height: String(10 + i),
          blockHash: "block-" + i,
          state: "confirmed",
          from: row.address,
          to: "0x2222222222222222222222222222222222222222",
          fee: "10000",
          createdAt: new Date().toISOString(),
          value: "1",
          data: { public: true },
        },
      ],
      [
        {
          hash,
          index: "native",
          asset,
          amount: "1",
          from: row.address,
          to: "0x2222222222222222222222222222222222222222",
          direction: "outgoing",
        },
      ],
      [
        {
          asset,
          height: String(10 + i),
          blockHash: "block-" + i,
          amount: "900719925474099312345",
        },
      ],
      [{ kind: "evm", position: String(10 + i), hash: "block-" + i }],
    );
  }
  try {
    const get = (url: string, who = "alice") =>
      app.inject({ url, headers: { "x-test-session": who } });
    expect(
      (await get("/api/v1/balances?watchId=" + row.id, "bob")).statusCode,
    ).toBe(403);
    const balances = (await get("/api/v1/balances?watchId=" + row.id)).json()
      .data.balances;
    expect(balances[0].raw).toBe("900719925474099312345");
    const first = (
      await get("/api/v1/activity?watchId=" + row.id + "&limit=1")
    ).json().data;
    expect(first.records).toHaveLength(1);
    expect(first.records[0].height).toBe("12");
    const second = (
      await get(
        "/api/v1/activity?" +
          new URLSearchParams({
            watchId: row.id,
            limit: "1",
            cursor: first.nextCursor,
          }),
      )
    ).json().data;
    expect(second.records[0].height).toBe("11");
    expect(second.records[0].hash).not.toBe(first.records[0].hash);
    const detail =
      "/api/v1/transactions/" +
      row.network_id +
      "/" +
      first.records[0].hash +
      "?watchId=" +
      row.id;
    expect((await get(detail)).statusCode).toBe(200);
    expect((await get(detail, "bob")).statusCode).toBe(403);
    const path = "/api/v1/notifications?watchId=" + row.id;
    expect((await get(path)).json().data.notifications).toHaveLength(3);
    expect((await get(path)).json().data.notifications).toHaveLength(0);
    db.prepare(
      "UPDATE transactions SET canonical=0,status='orphaned' WHERE hash=?",
    ).run(first.records[0].hash);
    expect((await get(path)).json().data.notifications).toEqual([
      {
        networkId: row.network_id,
        hash: first.records[0].hash,
        state: "orphaned",
      },
    ]);
    expect((await get(path)).json().data.notifications).toHaveLength(0);
    expect(
      (await get("/api/v1/assets?watchId=" + row.id, "bob")).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
    db.close();
  }
});
