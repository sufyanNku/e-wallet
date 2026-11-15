import type Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
export function migrate(db: Database.Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url)),
    files = readdirSync(directory)
      .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name))
      .sort();
  for (const name of files) {
    const version = Number(name.slice(0, 3)),
      sql = readFileSync(directory + name, "utf8"),
      checksum = createHash("sha256").update(sql).digest("hex"),
      existing = db
        .prepare("SELECT checksum FROM schema_migrations WHERE version=?")
        .get(version) as { checksum: string } | undefined;
    if (existing) {
      if (existing.checksum !== checksum)
        throw new Error("Applied SQL migration checksum differs: " + name);
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)",
      ).run(version, name, checksum, new Date().toISOString());
    })();
  }
}
