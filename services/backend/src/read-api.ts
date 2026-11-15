import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { JsonRpcProvider } from "ethers";
import { EvmAdapter } from "@ewallet/chain-evm";
import { networkById } from "@ewallet/config";
import type { AccountRef } from "@ewallet/domain";
import { networkRpc } from "./node-rpc";
import type { PublicIndexer, WatchRow } from "./public-indexer";
export function registerReadApi(
  app: FastifyInstance,
  db: Database.Database,
  session: (r: FastifyRequest) => { id: string } | undefined,
  indexer: PublicIndexer,
) {
  function watch(req: FastifyRequest) {
    const id = z
        .string()
        .uuid()
        .parse((req.query as { watchId?: string }).watchId),
      sid = session(req)?.id,
      row = db
        .prepare("SELECT * FROM watched_accounts WHERE id=? AND session_id=?")
        .get(id, sid ?? "") as WatchRow | undefined;
    if (!row) throw new Error("DENIED");
    db.prepare(
      "UPDATE watched_accounts SET last_active_at=? WHERE id=? AND session_id=?",
    ).run(Date.now(), row.id, row.session_id);
    return row;
  }
  const handler =
    (fn: (req: FastifyRequest) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        reply.header("Cache-Control", "no-store");
        return {
          data: await fn(req),
          meta: { source: "node", observedAt: new Date().toISOString() },
        };
      } catch (e) {
        const denied = e instanceof Error && e.message === "DENIED",
          invalid = e instanceof z.ZodError;
        return reply.code(denied ? 403 : invalid ? 400 : 503).send({
          error: {
            code: denied
              ? "WATCH_SESSION"
              : invalid
                ? "READ_SCHEMA"
                : "READ_UNAVAILABLE",
            message: denied
              ? "This public watch is not authorized for the current session."
              : invalid
                ? "Invalid public data query."
                : "Public data unavailable; no fixture fallback was used.",
            correlationId: req.id,
          },
        });
      }
    };
  function balances(row: WatchRow): Array<Record<string, unknown>> {
    return (
      db
        .prepare(
          `SELECT a.asset_key AS assetKey,a.network_id AS networkId,a.standard,a.reference,a.token_id AS tokenId,a.decimals,a.symbol,a.name,s.amount AS raw,s.height AS observedHeight,s.block_hash AS blockHash,s.observed_at AS observedAt,s.stale FROM balance_snapshots s JOIN assets a ON a.asset_key=s.asset_key WHERE s.watch_id=? AND NOT EXISTS(SELECT 1 FROM balance_snapshots newer WHERE newer.watch_id=s.watch_id AND newer.asset_key=s.asset_key AND CAST(newer.height AS INTEGER)>CAST(s.height AS INTEGER)) ORDER BY a.asset_key LIMIT 200`,
        )
        .all(row.id) as Array<Record<string, unknown>>
    ).map((b) => ({
      ...b,
      source: "node",
      stale:
        b.stale === 1 || Date.now() - Date.parse(String(b.observedAt)) > 30000,
    }));
  }
  app.get(
    "/api/v1/balances",
    handler(async (req) => {
      const row = watch(req);
      void indexer.step(row).catch(() => {});
      return {
        watchId: row.id,
        networkId: row.network_id,
        status: row.status,
        balances: balances(row),
      };
    }),
  );
  for (const path of ["assets", "collectibles"])
    app.get(
      "/api/v1/" + path,
      handler(async (req) => {
        const row = watch(req),
          records = balances(row).filter(
            (b) =>
              path === "assets" ||
              (["erc721", "erc1155", "solana-nft"].includes(
                String(b.standard),
              ) &&
                b.raw !== "0"),
          );
        return {
          watchId: row.id,
          networkId: row.network_id,
          status: row.status,
          records: records.map((b) => ({
            ...b,
            metadata:
              db
                .prepare(
                  "SELECT status,metadata_json AS content,content_hash AS contentHash FROM metadata_cache WHERE asset_key=?",
                )
                .get(b.assetKey) ?? null,
          })),
        };
      }),
    );
  app.get(
    "/api/v1/transactions/:network/:hash",
    handler(async (req) => {
      const row = watch(req),
        params = z
          .object({
            network: z.string().max(80),
            hash: z.string().regex(/^[A-Za-z0-9]{20,100}$/),
          })
          .parse(req.params);
      if (params.network !== row.network_id) throw new Error("DENIED");
      const transaction = db
        .prepare(
          "SELECT DISTINCT t.* FROM transactions t JOIN watch_transactions w ON w.network_id=t.network_id AND w.tx_hash=t.hash WHERE w.watch_id=? AND t.network_id=? AND t.hash=? AND t.fingerprint=?",
        )
        .get(row.id, row.network_id, params.hash, row.fingerprint);
      if (!transaction) throw new Error("DENIED");
      return { watchId: row.id, transaction };
    }),
  );
  class Provider extends JsonRpcProvider {
    constructor(private networkId: string) {
      super(undefined, BigInt(networkById(networkId).identity), {
        staticNetwork: true,
        cacheTimeout: 0,
      });
    }
    override send(method: string, params: unknown[] | Record<string, unknown>) {
      if (!Array.isArray(params)) throw new Error("RPC params");
      return networkRpc(this.networkId, method, params);
    }
  }
  class Adapter extends EvmAdapter {
    override async manifest() {
      return indexer.manifest(this.networkId);
    }
    override async environment() {
      return {
        bootEpoch: (
          await import("./environment").then((m) =>
            m.currentEpoch(this.networkId),
          )
        ).bootEpoch,
        state: "ready" as const,
      };
    }
  }
  app.get(
    "/api/v1/contracts/:network/state",
    handler(async (req) => {
      const row = watch(req),
        network = z.string().parse((req.params as { network: string }).network);
      if (network !== row.network_id || network !== "eip155:31337")
        throw new Error("DENIED");
      const provider = new Provider(network);
      try {
        const account: AccountRef = {
            id: row.id,
            rootWalletId: "public-watch",
            family: "evm",
            address: row.address,
            path: "m/44'/60'/0'/0/0",
            index: 0,
            name: "Public watch",
          },
          state = await new Adapter(network, provider).services(account),
          events = db
            .prepare(
              "SELECT contract_address AS contract,tx_hash AS hash,event_name AS name,payload_json AS payload,canonical FROM contract_events WHERE network_id=? AND canonical=1 ORDER BY rowid DESC LIMIT 100",
            )
            .all(network);
        return { watchId: row.id, state, events, source: "node-reconciled" };
      } finally {
        provider.destroy();
      }
    }),
  );
  app.get(
    "/api/v1/notifications",
    handler(async (req) => {
      const row = watch(req),
        sid = session(req)!.id,
        transactions = db
          .prepare(
            `SELECT DISTINCT t.hash,t.status,t.canonical FROM transactions t WHERE t.network_id=? AND t.fingerprint=? AND (EXISTS(SELECT 1 FROM watch_transactions w WHERE w.watch_id=? AND w.tx_hash=t.hash AND w.network_id=t.network_id) OR EXISTS(SELECT 1 FROM notification_receipts n WHERE n.session_id=? AND n.network_id=t.network_id AND n.tx_hash=t.hash)) AND t.status IN ('confirmed','finalized','reverted','orphaned') ORDER BY t.last_observed_at DESC LIMIT 100`,
          )
          .all(row.network_id, row.fingerprint, row.id, sid) as Array<{
          hash: string;
          status: string;
          canonical: number;
        }>,
        notifications: Array<{
          networkId: string;
          hash: string;
          state: string;
        }> = [];
      db.transaction(() => {
        for (const t of transactions) {
          const state = t.canonical ? t.status : "orphaned",
            result = db
              .prepare(
                "INSERT OR IGNORE INTO notification_receipts(session_id,network_id,tx_hash,state,delivered_at) VALUES (?,?,?,?,?)",
              )
              .run(
                sid,
                row.network_id,
                t.hash,
                state,
                new Date().toISOString(),
              );
          if (result.changes)
            notifications.push({
              networkId: row.network_id,
              hash: t.hash,
              state,
            });
        }
      })();
      return { watchId: row.id, notifications };
    }),
  );
}
