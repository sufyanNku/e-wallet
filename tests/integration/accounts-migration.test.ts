import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { migrate } from "../../services/backend/src/migrations";

it("upgrades existing account balances, history and roles without replacing seeded data", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)",
  );
  const directory = "services/backend/migrations/";
  for (const name of readdirSync(directory)
    .filter((n) => /^00[1-9]_.*\.sql$/.test(n))
    .sort()) {
    const sql = readFileSync(directory + name, "utf8");
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)").run(
      Number(name.slice(0, 3)),
      name,
      createHash("sha256").update(sql).digest("hex"),
      new Date().toISOString(),
    );
  }
  db.prepare(
    "INSERT INTO sessions(id,csrf_hash,expires_at) VALUES ('session','hash',9999999999999)",
  ).run();
  for (const [id, role, balance] of [
    ["alice", "member", 97485],
    ["bob", "member", 102515],
    ["admin", "admin", 0],
    ["auditor", "auditor", 0],
  ])
    db.prepare(
      "INSERT INTO team_demo_users(id,username,display_name,role,password_salt,password_hash,balance_cents) VALUES (?,?,?,?,?,?,?)",
    ).run(id, id, id, role, "salt", "hash", balance);
  db.prepare(
    "INSERT INTO team_demo_sessions VALUES ('token','alice','session',9999999999999)",
  ).run();
  db.prepare(
    "INSERT INTO team_demo_transfers VALUES ('receipt','request','alice','bob',2515,'2026-11-19T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO team_demo_audit(actor_id,action,subject_id,created_at) VALUES ('alice','transfer','receipt','2026-11-19T00:00:00Z')",
  ).run();
  for (const source of ["local-fixture", "remote-https"])
    db.prepare(
      "INSERT INTO metadata_cache(asset_key,status,metadata_json,source) VALUES (?,'safe','{}',?)",
    ).run(source, source);
  migrate(db);
  migrate(db);
  expect(
    db
      .prepare(
        "SELECT username,role,balance_cents FROM account_users ORDER BY username",
      )
      .all(),
  ).toEqual([
    { username: "admin", role: "admin", balance_cents: 0 },
    { username: "alice", role: "member", balance_cents: 97485 },
    { username: "auditor", role: "auditor", balance_cents: 0 },
    { username: "bob", role: "member", balance_cents: 102515 },
  ]);
  expect(db.prepare("SELECT id FROM account_transfers").get()).toEqual({
    id: "receipt",
  });
  expect(db.prepare("SELECT action FROM account_audit").get()).toEqual({
    action: "transfer",
  });
  expect(db.prepare("SELECT user_id FROM account_sessions").get()).toEqual({
    user_id: "alice",
  });
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(db.prepare("SELECT source FROM metadata_cache").all()).toEqual([
    { source: "remote-https" },
  ]);
  db.close();
});
