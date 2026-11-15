import Database from "better-sqlite3";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { migrate } from "../services/backend/src/migrations";
import {
  PublicIndexer,
  type WatchRow,
} from "../services/backend/src/public-indexer";
const family = process.argv[2] ?? "evm",
  persistent = process.argv.includes("--persist"),
  purpose = process.argv.includes("--purpose=86") ? 86 : 84;
if (
  persistent &&
  (process.env.EWALLET_ISOLATED_SOLANA_TEST ||
    process.env.EWALLET_ISOLATED_BITCOIN_TEST)
)
  throw new Error(
    "Persistent indexing is restricted to the main local namespace",
  );
if (persistent) await mkdir(".local/local", { recursive: true });
const db = new Database(
  persistent ? ".local/local/backend.sqlite" : ":memory:",
);
if (persistent) db.pragma("journal_mode=WAL");
db.pragma("foreign_keys=ON");
migrate(db);
const errors: unknown[] = [],
  indexer = new PublicIndexer(db, (error) => errors.push(error));
db.prepare(
  "INSERT INTO sessions(id,csrf_hash,expires_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at",
).run(
  "fixture-index",
  "not-an-http-credential",
  persistent ? 253402300799000 : Date.now() + 600000,
);
let address: string,
  network: string,
  start = "0",
  descriptor: string | null = null;
if (family === "evm") {
  const manifest = JSON.parse(
    await readFile("artifacts/seed/evm-manifest.json", "utf8"),
  );
  address = manifest.identities.alice.evm.address.toLowerCase();
  network = "eip155:31337";
  start = manifest.deployments[0].deploymentBlock;
} else if (family === "solana") {
  const manifest = JSON.parse(
    await readFile(
      process.env.EWALLET_ISOLATED_SOLANA_TEST === "1"
        ? "artifacts/phase-03/isolated-solana-manifest.json"
        : "artifacts/seed/solana-manifest.json",
      "utf8",
    ),
  );
  address = manifest.identities.alice.address;
  network = "solana:local";
} else if (family === "bitcoin") {
  const manifest = JSON.parse(
      await readFile(
        process.env.EWALLET_ISOLATED_BITCOIN_TEST === "1"
          ? "artifacts/phase-03/isolated-bitcoin-manifest.json"
          : "artifacts/seed/bitcoin-manifest.json",
        "utf8",
      ),
    ),
    watch = manifest.identities.alice.find(
      (w: { purpose: number }) => w.purpose === purpose,
    );
  address = manifest.finalBalances.find(
    (a: { name: string; purpose: number }) =>
      a.name === "alice" && a.purpose === purpose,
  ).address;
  network = "bitcoin:regtest";
  descriptor = createHash("sha256")
    .update("public-seed:" + purpose + ":" + manifest.fundingEpoch)
    .digest("hex");
  const id = createHash("sha256").update(JSON.stringify(watch)).digest("hex");
  db.prepare(
    "INSERT OR IGNORE INTO btc_accounts(id,public_json) VALUES (?,?)",
  ).run(id, JSON.stringify(watch));
  db.prepare(
    "INSERT OR REPLACE INTO btc_sessions(watch_id,session_id,account_id) VALUES (?,?,?)",
  ).run(descriptor, "fixture-index", id);
} else throw new Error("Select evm, solana or bitcoin");
const existing = db
    .prepare(
      "SELECT id FROM watched_accounts WHERE session_id=? AND network_id=? AND address=?",
    )
    .get("fixture-index", network, address) as { id: string } | undefined,
  id = existing?.id ?? randomUUID();
db.prepare(
  "INSERT OR IGNORE INTO watched_accounts(id,session_id,network_id,address,descriptor_ref,watch_start,status,added_at) VALUES (?,?,?,?,?,?,?,?)",
).run(
  id,
  "fixture-index",
  network,
  address,
  descriptor,
  start,
  "syncing",
  new Date().toISOString(),
);
if (descriptor)
  db.prepare("UPDATE watched_accounts SET descriptor_ref=? WHERE id=?").run(
    descriptor,
    id,
  );
for (let batch = 0; batch < 100; batch++) {
  const watch = db
    .prepare("SELECT * FROM watched_accounts WHERE id=?")
    .get(id) as WatchRow;
  await indexer.step(watch);
  const current = db
    .prepare("SELECT status FROM watched_accounts WHERE id=?")
    .get(id) as { status: string };
  if (current.status === "unavailable")
    throw new Error(
      "Indexer failed: " +
        (errors.at(-1) instanceof Error
          ? (errors.at(-1) as Error).message
          : "unknown"),
      { cause: errors.at(-1) },
    );
  if (current.status === "ready") break;
  if (batch === 99)
    throw new Error("Index backfill exceeded bounded test batch count");
}
const watch = db
    .prepare("SELECT * FROM watched_accounts WHERE id=?")
    .get(id) as WatchRow,
  countTransfers = () =>
    db
      .prepare(
        "SELECT count(*) AS n FROM transfers f JOIN transactions t ON t.network_id=f.network_id AND t.hash=f.tx_hash WHERE f.network_id=? AND t.fingerprint=? AND f.canonical=1 AND t.canonical=1",
      )
      .get(network, watch.fingerprint) as { n: number },
  first = countTransfers();
await indexer.step(watch);
const second = countTransfers();
if (first.n !== second.n)
  throw new Error("Repeated index batch inserted duplicate transfers.");
const snapshots = db
    .prepare("SELECT count(*) AS n FROM balance_snapshots WHERE watch_id=?")
    .get(id) as { n: number },
  links = db
    .prepare("SELECT count(*) AS n FROM watch_transactions WHERE watch_id=?")
    .get(id) as { n: number },
  transactions = db
    .prepare(
      "SELECT count(*) AS n FROM transactions WHERE network_id=? AND fingerprint=? AND canonical=1",
    )
    .get(network, watch.fingerprint) as { n: number };
if (
  (family !== "solana" || process.env.EWALLET_ISOLATED_SOLANA_TEST === "1") &&
  links.n === 0
)
  throw new Error("No real chain history was indexed");
await mkdir("artifacts/phase-04", { recursive: true });
await writeFile(
  "artifacts/phase-04/index-" + family + ".json",
  JSON.stringify(
    {
      source: "node",
      persistent,
      networkId: network,
      fingerprint: watch.fingerprint,
      transactions: transactions.n,
      transfers: second.n,
      scopedLinks: links.n,
      balanceSnapshots: snapshots.n,
      idempotent: true,
      coverage:
        family === "evm"
          ? "Registered contract events and outer native transactions"
          : family === "solana"
            ? "Available signatures for owner and token accounts; earlier pruned history is unavailable"
            : "Public watch descriptors, referenced inputs and independently derived change",
      isolated:
        process.env.EWALLET_ISOLATED_SOLANA_TEST === "1" ||
        process.env.EWALLET_ISOLATED_BITCOIN_TEST === "1",
    },
    null,
    2,
  ),
);
await indexer.close();
db.close();
console.log(
  family +
    ": actual chain activity indexed and repeated-batch deduplication verified.",
);
