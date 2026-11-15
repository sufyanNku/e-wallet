import { linkCachedActivity } from "./cached-watch";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  validateWatch,
  bitcoinWatchSchema,
  deriveWatchAddress,
  satoshis,
  hex,
  bitcoin,
  type BitcoinWatch,
} from "@ewallet/chain-bitcoin";
import {
  bitcoinRpc,
  bitcoinIdentity,
  ensurePublicDescriptor,
} from "./bitcoin-rpc";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const outputSchema = z.object({
  txid: z.string().regex(/^[a-f0-9]{64}$/),
  vout: z.string().regex(/^[0-9]+$/),
  address: z.string(),
  scriptPubKey: z.string(),
  amount: z.string(),
  confirmations: z.string(),
  spendable: z.boolean(),
  solvable: z.boolean(),
  safe: z.boolean(),
});
export async function registerBitcoinWatch(
  app: FastifyInstance,
  db: Database.Database,
  session: (request: FastifyRequest) => { id: string } | undefined,
) {
  const cache = new Map<
    string,
    Map<string, ReturnType<typeof deriveWatchAddress>>
  >();
  function lookup(watch: BitcoinWatch) {
    const key = hash(JSON.stringify(watch));
    let scripts = cache.get(key);
    if (!scripts) {
      scripts = new Map();
      for (const branch of [0, 1] as const)
        for (let i = 0; i < 1000; i++) {
          const d = deriveWatchAddress(watch, branch, i);
          scripts.set(d.scriptHex, d);
        }
      if (cache.size >= 20) cache.delete(cache.keys().next().value!);
      cache.set(key, scripts);
    }
    return scripts;
  }
  function owned(request: FastifyRequest, id: unknown) {
    const sessionId = session(request)?.id;
    if (!sessionId) throw new Error("SESSION");
    const watchId = z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(id);
    const row = db
      .prepare(
        "SELECT a.*,s.watch_id FROM btc_sessions s JOIN btc_accounts a ON a.id=s.account_id WHERE s.watch_id=? AND s.session_id=?",
      )
      .get(watchId, sessionId) as
      | {
          id: string;
          public_json: string;
          next_external: number;
          next_change: number;
        }
      | undefined;
    if (!row) throw new Error("SESSION");
    return { ...row, watch: validateWatch(JSON.parse(row.public_json)) };
  }
  const handle =
    (fn: (req: FastifyRequest) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
      try {
        reply.header("Cache-Control", "no-store");
        return {
          data: await fn(req),
          meta: { source: "node", observedAt: new Date().toISOString() },
        };
      } catch (error) {
        const denied = error instanceof Error && error.message === "SESSION";
        return reply
          .code(denied ? 403 : error instanceof z.ZodError ? 400 : 503)
          .send({
            error: {
              code: denied ? "WATCH_SESSION" : "BITCOIN_UNAVAILABLE",
              message: denied
                ? "This watch is not authorized for the current session."
                : "Unable to reconcile the regtest watch. Check the local node and watch-only wallet.",
              correlationId: req.id,
            },
          });
      }
    };
  app.post(
    "/api/v1/bitcoin/watch",
    handle(async (req) => {
      const body = z
          .object({ acknowledged: z.literal(true), watch: bitcoinWatchSchema })
          .strict()
          .parse(req.body),
        watch = validateWatch(body.watch),
        sessionId = session(req)?.id;
      if (!sessionId) throw new Error("SESSION");
      const state = await bitcoinIdentity();
      const info = (await bitcoinRpc("getwalletinfo", [], "ewallet-watch")) as {
        private_keys_enabled: boolean;
      };
      if (info.private_keys_enabled !== false)
        throw new Error("Watch wallet unexpectedly has private keys");
      const id = hash(JSON.stringify(watch) + String(state.ledgerFingerprint)),
        watchId = hash(sessionId + ":" + id);
      if (!db.prepare("SELECT 1 FROM btc_accounts WHERE id=?").get(id)) {
        for (const internal of [0, 1] as const)
          await ensurePublicDescriptor(watch, internal);
        db.prepare(
          "INSERT OR IGNORE INTO btc_accounts(id,public_json) VALUES (?,?)",
        ).run(id, JSON.stringify(watch));
      }
      db.prepare(
        "INSERT OR IGNORE INTO btc_sessions(watch_id,session_id,account_id) VALUES (?,?,?)",
      ).run(watchId, sessionId, id);
      const address = deriveWatchAddress(watch, 0, 0).address,
        historyId = randomUUID();
      db.prepare(
        "INSERT OR IGNORE INTO watched_accounts(id,session_id,network_id,address,descriptor_ref,watch_start,status,added_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        historyId,
        sessionId,
        "bitcoin:regtest",
        address,
        watchId,
        "0",
        "syncing",
        new Date().toISOString(),
      );
      db.prepare(
        "UPDATE watched_accounts SET descriptor_ref=?,last_active_at=? WHERE session_id=? AND network_id=? AND address=?",
      ).run(watchId, Date.now(), sessionId, "bitcoin:regtest", address);
      const history = db
        .prepare(
          "SELECT id FROM watched_accounts WHERE session_id=? AND network_id=? AND address=?",
        )
        .get(sessionId, "bitcoin:regtest", address) as { id: string };
      linkCachedActivity(
        db,
        history.id,
        "bitcoin:regtest",
        address,
        String(state.ledgerFingerprint),
        "0",
      );
      return {
        watchId,
        historyWatchId: history.id,
        genesisHash: await bitcoinRpc("getblockhash", [0]),
      };
    }),
  );
  app.post(
    "/api/v1/bitcoin/utxos",
    handle(async (req) => {
      const { watchId } = z
          .object({ watchId: z.string() })
          .strict()
          .parse(req.body),
        owner = owned(req, watchId),
        state = await bitcoinIdentity(),
        scripts = lookup(owner.watch);
      const rows = z
          .array(outputSchema)
          .parse(
            await bitcoinRpc(
              "listunspent",
              [0, 9999999, [], true],
              "ewallet-watch",
            ),
          ),
        utxos = [];
      for (const row of rows) {
        const derived = scripts.get(row.scriptPubKey);
        if (!derived || !row.solvable || !row.safe) continue;
        const rawTransaction = z
          .string()
          .parse(await bitcoinRpc("getrawtransaction", [row.txid, false]));
        utxos.push({
          txid: row.txid,
          vout: Number(row.vout),
          value: satoshis(row.amount),
          confirmations: row.confirmations,
          ...derived,
          rawTransaction,
        });
      }
      // Historical output matching recognizes used internal addresses even after
      // their outputs have been spent; raw wallet history never leaves this boundary.
      const transactions = (await bitcoinRpc(
        "listtransactions",
        ["*", 1000, 0, true],
        "ewallet-watch",
      )) as Array<{ txid: string }>;
      const used = new Set<string>();
      for (const txid of new Set(transactions.map((t) => t.txid))) {
        const raw = await bitcoinRpc("getrawtransaction", [txid, false]);
        if (typeof raw !== "string") throw new Error("Invalid raw transaction");
        for (const output of bitcoin.Transaction.fromHex(raw).outs) {
          const derived = scripts.get(hex(output.script));
          if (derived) used.add(derived.address);
        }
      }
      const discovery = ([0, 1] as const).map((change) => {
        const branch = Array.from(scripts.values()).filter(
            (d) => d.change === change,
          ),
          lastUsed = Math.max(
            -1,
            ...branch
              .filter((d) => used.has(d.address))
              .map((d) => d.addressIndex),
          ),
          allocated =
            (change === 0 ? owner.next_external : owner.next_change) - 1,
          target = Math.max(lastUsed, allocated),
          next = target + 21;
        if (next > 1000)
          throw new Error("Discovery exceeds the imported range.");
        return { change, lastUsed, next, gapLimit: 20 };
      });
      const estimate = (await bitcoinRpc("estimatesmartfee", [6])) as {
        feerate?: string;
      };
      let feeRate = "2",
        feeSource = "local regtest fallback";
      if (estimate.feerate) {
        const perKvbyte = BigInt(satoshis(estimate.feerate));
        feeRate = String((perKvbyte + 999n) / 1000n);
        feeSource = "Bitcoin Core estimatesmartfee";
      }
      return {
        watchId,
        genesisHash: await bitcoinRpc("getblockhash", [0]),
        ledgerFingerprint: state.ledgerFingerprint,
        height: state.blocks,
        blockHash: state.bestblockhash,
        utxos: utxos.map(({ publicKey: _key, ...u }) => u),
        discovery,
        feeRate,
        feeSource,
        observationId: randomUUID(),
      };
    }),
  );
  app.post(
    "/api/v1/bitcoin/address",
    handle(async (req) => {
      const body = z
          .object({
            watchId: z.string(),
            change: z.union([z.literal(0), z.literal(1)]),
            minimumIndex: z.number().int().min(0).max(999),
          })
          .strict()
          .parse(req.body),
        owner = owned(req, body.watchId),
        column = body.change === 0 ? "next_external" : "next_change";
      const allocate = db.transaction(() => {
        const current = db
          .prepare(`SELECT ${column} AS n FROM btc_accounts WHERE id=?`)
          .get(owner.id) as { n: number };
        const index = Math.max(current.n, body.minimumIndex);
        if (index > 999) throw new Error("Address allocation bound exceeded");
        db.prepare(`UPDATE btc_accounts SET ${column}=? WHERE id=?`).run(
          index + 1,
          owner.id,
        );
        return index;
      });
      return deriveWatchAddress(owner.watch, body.change, allocate());
    }),
  );
}
