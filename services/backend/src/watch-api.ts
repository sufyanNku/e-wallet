import { linkCachedActivity } from "./cached-watch";
import { networkHealth } from "./network-health";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { networkById } from "@ewallet/config";
import { PublicIndexer, type WatchRow } from "./public-indexer";
import { networkRpc } from "./node-rpc";
export async function registerWatchApi(
  app: FastifyInstance,
  db: Database.Database,
  session: (request: FastifyRequest) => { id: string } | undefined,
) {
  const indexer = new PublicIndexer(db),
    row = (request: FastifyRequest, id: unknown) => {
      const active = session(request);
      if (!active) throw new Error("WATCH_SESSION");
      const watch = db
        .prepare("SELECT * FROM watched_accounts WHERE id=? AND session_id=?")
        .get(z.string().uuid().parse(id), active.id) as WatchRow | undefined;
      if (!watch) throw new Error("WATCH_SESSION");
      return watch;
    };
  const handler =
    (action: (req: FastifyRequest) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        reply.header("Cache-Control", "no-store");
        return { data: await action(req), meta: { source: "node" } };
      } catch (error) {
        const denied =
            error instanceof Error && error.message === "WATCH_SESSION",
          invalid = error instanceof z.ZodError;
        return reply.code(denied ? 403 : invalid ? 400 : 503).send({
          error: {
            code: denied
              ? "WATCH_SESSION"
              : invalid
                ? "WATCH_SCHEMA"
                : "INDEX_UNAVAILABLE",
            message: denied
              ? "This watch is not authorized for the current session."
              : invalid
                ? "The watch request exceeds the supported schema."
                : "Indexed activity is temporarily unavailable. Current balances remain independent.",
            correlationId: req.id,
          },
        });
      }
    };
  app.post(
    "/api/v1/watch",
    handler(async (req) => {
      const body = z
          .object({
            networkId: z.string().max(80),
            address: z.string().max(200),
            startHeight: z
              .string()
              .regex(/^[0-9]+$/)
              .optional(),
            backfillAcknowledged: z.boolean().default(false),
          })
          .strict()
          .parse(req.body),
        profile = networkById(body.networkId),
        active = session(req);
      if (!active) throw new Error("WATCH_SESSION");
      if (profile.family === "bitcoin")
        throw new z.ZodError([
          {
            code: "custom",
            path: ["networkId"],
            message: "Use the separately consented Bitcoin descriptor watch.",
          },
        ]);
      const address =
          profile.family === "evm"
            ? z
                .string()
                .regex(/^0x[0-9a-f]{40}$/i)
                .parse(body.address)
                .toLowerCase()
            : z
                .string()
                .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
                .parse(body.address),
        fingerprint = await indexer.fingerprint(profile.id),
        existing = db
          .prepare(
            "SELECT * FROM watched_accounts WHERE session_id=? AND network_id=? AND address=?",
          )
          .get(active.id, profile.id, address) as WatchRow | undefined;
      if (existing)
        db.prepare(
          "UPDATE watched_accounts SET last_active_at=? WHERE id=? AND session_id=?",
        ).run(Date.now(), existing.id, active.id);
      if (existing)
        linkCachedActivity(
          db,
          existing.id,
          profile.id,
          address,
          fingerprint,
          existing.watch_start,
        );
      if (existing)
        return { watchId: existing.id, status: existing.status, fingerprint };
      const count = db
        .prepare(
          "SELECT count(*) AS n FROM watched_accounts WHERE session_id=?",
        )
        .get(active.id) as { n: number };
      if (count.n >= 20)
        throw new z.ZodError([
          {
            code: "custom",
            path: [],
            message: "Watch limit is twenty accounts per session.",
          },
        ]);
      let start = "0";
      if (profile.family === "evm") {
        const height = BigInt(
            String(await networkRpc(profile.id, "eth_blockNumber")),
          ),
          manifest = await indexer.manifest(profile.id);
        start = body.startHeight ?? manifest?.deploymentBlock ?? String(height);
        if (
          BigInt(start) > height ||
          height - BigInt(start) > 5000n ||
          (body.startHeight !== undefined && !body.backfillAcknowledged)
        )
          throw new z.ZodError([
            {
              code: "custom",
              path: ["startHeight"],
              message:
                "Backfill requires acknowledgement and a range within 5,000 blocks.",
            },
          ]);
      }
      const id = randomUUID();
      db.prepare(
        "INSERT OR IGNORE INTO watched_accounts(id,session_id,network_id,address,watch_start,status,added_at,fingerprint) VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        id,
        active.id,
        profile.id,
        address,
        start,
        "syncing",
        new Date().toISOString(),
        fingerprint,
      );
      const registered = db
        .prepare(
          "SELECT id,status FROM watched_accounts WHERE session_id=? AND network_id=? AND address=?",
        )
        .get(active.id, profile.id, address) as { id: string; status: string };
      db.prepare(
        "UPDATE watched_accounts SET last_active_at=? WHERE id=? AND session_id=?",
      ).run(Date.now(), registered.id, active.id);
      linkCachedActivity(
        db,
        registered.id,
        profile.id,
        address,
        fingerprint,
        start,
      );
      return { watchId: registered.id, status: registered.status, fingerprint };
    }),
  );
  app.delete(
    "/api/v1/watch/:id",
    handler(async (req) => {
      const watch = row(req, (req.params as { id: string }).id);
      db.prepare(
        "DELETE FROM watched_accounts WHERE id=? AND session_id=?",
      ).run(watch.id, watch.session_id);
      return { removed: true };
    }),
  );
  app.get(
    "/api/v1/activity",
    handler(async (req) => {
      const query = z
          .object({
            watchId: z.string().uuid(),
            cursor: z.string().max(1024).default("0"),
            limit: z.coerce.number().int().min(1).max(50).default(25),
          })
          .strict()
          .parse(req.query),
        watch = row(req, query.watchId);
      const decoded =
        query.cursor === "0"
          ? null
          : z
              .object({
                watchId: z.string().uuid(),
                height: z.string().regex(/^[0-9]+$/),
                hash: z.string().max(100),
                eventIndex: z.string().max(100),
              })
              .strict()
              .parse(
                JSON.parse(
                  Buffer.from(
                    z
                      .string()
                      .regex(/^[A-Za-z0-9_-]+$/)
                      .parse(query.cursor),
                    "base64url",
                  ).toString("utf8"),
                ),
              );
      if (decoded && decoded.watchId !== watch.id)
        throw new Error("WATCH_SESSION");
      db.prepare(
        "UPDATE watched_accounts SET last_active_at=? WHERE id=? AND session_id=?",
      ).run(Date.now(), watch.id, watch.session_id);
      void indexer.step(watch).catch(() => {});
      const current = db
          .prepare("SELECT * FROM watched_accounts WHERE id=?")
          .get(watch.id) as WatchRow,
        cursor = db
          .prepare(
            "SELECT position,last_synced_at,error_code FROM sync_cursors WHERE watch_id=? AND kind IN ('evm','solana','bitcoin') ORDER BY last_synced_at DESC LIMIT 1",
          )
          .get(watch.id) as
          | {
              position: string;
              last_synced_at: string | null;
              error_code: string | null;
            }
          | undefined;
      const after = decoded
        ? " AND (CAST(t.height AS INTEGER)<? OR (t.height=? AND (t.hash<? OR (t.hash=? AND f.event_index<?))))"
        : "";
      const records = db
        .prepare(
          `SELECT t.network_id AS networkId,t.hash,t.height,t.block_hash AS blockHash,t.status AS state,t.fee,t.created_at AS createdAt,t.canonical,t.data_json AS transactionData,f.event_index AS eventIndex,f.asset_key AS assetKey,f.amount,f.from_address AS sender,f.to_address AS recipient,a.standard,a.reference,a.token_id AS tokenId,a.decimals,a.symbol,a.name,w.direction FROM transfers f JOIN watch_transactions w ON w.network_id=f.network_id AND w.tx_hash=f.tx_hash AND w.event_index=f.event_index JOIN transactions t ON t.network_id=f.network_id AND t.hash=f.tx_hash JOIN assets a ON a.asset_key=f.asset_key WHERE t.network_id=? AND t.fingerprint=? AND w.watch_id=?${after} ORDER BY CAST(t.height AS INTEGER) DESC,t.hash DESC,f.event_index DESC LIMIT ?`,
        )
        .all(
          watch.network_id,
          current.fingerprint,
          watch.id,
          ...(decoded
            ? [
                Number(decoded.height),
                decoded.height,
                decoded.hash,
                decoded.hash,
                decoded.eventIndex,
              ]
            : []),
          query.limit + 1,
        ) as Array<Record<string, unknown>>;
      const hasMore = records.length > query.limit;
      return {
        watchId: watch.id,
        networkId: watch.network_id,
        status: current.status,
        fingerprint: current.fingerprint,
        address: current.address,
        observedHeight: cursor?.last_synced_at ? cursor.position : null,
        observedAt: cursor?.last_synced_at ?? null,
        errorCode: cursor?.error_code ?? null,
        coverage:
          networkById(watch.network_id).family === "evm"
            ? "Registered token/NFT events and outer native transfers; internal native trace coverage is incomplete."
            : "Indexed supported chain activity.",
        records: records
          .slice(0, query.limit)
          .map(({ transactionData: _raw, ...r }) => ({
            ...r,
            canonical: r.canonical === 1,
          })),
        nextCursor: hasMore
          ? Buffer.from(
              JSON.stringify({
                watchId: watch.id,
                height: String(records[query.limit - 1].height),
                hash: String(records[query.limit - 1].hash),
                eventIndex: String(records[query.limit - 1].eventIndex),
              }),
            ).toString("base64url")
          : null,
      };
    }),
  );
  app.get("/api/v1/networks", async () => ({
    data: networkHealth(),
    meta: { source: "configuration-and-node", health: "/api/v1/health" },
  }));
  let activeTick = false;
  const timer = setInterval(() => {
    if (activeTick) return;
    activeTick = true;
    void (async () => {
      const watches = db
        .prepare(
          "SELECT w.* FROM watched_accounts w JOIN sessions s ON s.id=w.session_id LEFT JOIN sync_cursors c ON c.watch_id=w.id WHERE s.expires_at>? AND w.last_active_at>? AND COALESCE(c.next_poll_at,0)<=? GROUP BY w.id ORDER BY COALESCE(c.next_poll_at,0) LIMIT 3",
        )
        .all(Date.now(), Date.now() - 90000, Date.now()) as WatchRow[];
      await Promise.allSettled(
        watches.map(async (w) => {
          await indexer.step(w);
          const activity = db
            .prepare("SELECT last_active_at FROM watched_accounts WHERE id=?")
            .get(w.id) as { last_active_at: number } | undefined;
          if (activity && activity.last_active_at < Date.now() - 10000)
            db.prepare(
              "UPDATE sync_cursors SET next_poll_at=? WHERE watch_id=?",
            ).run(Date.now() + 30000, w.id);
        }),
      );
    })().finally(() => {
      activeTick = false;
    });
  }, 5000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await indexer.close();
  });
  return indexer;
}
