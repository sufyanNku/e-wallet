import Database from "better-sqlite3";
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { migrate } from "../services/backend/src/migrations";
import {
  accountPasswordHash,
  accountsEnabled,
} from "../services/backend/src/accounts";
import { runtimeConfig } from "../services/backend/src/runtime-config";

if (!accountsEnabled({ ...process.env, EWALLET_ACCOUNTS: "1" }))
  throw new Error("Accounts can only be prepared in local development mode.");
const databasePath = runtimeConfig().databasePath;
const file = dirname(databasePath) + "/accounts-credentials.json";
const schema = z
  .array(
    z
      .object({
        id: z.string().uuid(),
        username: z.enum(["alice", "bob", "admin", "auditor"]),
        displayName: z.string(),
        role: z.enum(["admin", "member", "auditor"]),
        password: z.string().min(12),
      })
      .strict(),
  )
  .length(4);
await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
let credentials: z.infer<typeof schema>;
try {
  credentials = schema.parse(JSON.parse(await readFile(file, "utf8")));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  const legacy = dirname(databasePath) + "/team-demo-credentials.json";
  try {
    await rename(legacy, file);
  } catch (legacyError) {
    if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT")
      throw legacyError;
  }
  try {
    credentials = schema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (missing) {
    if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
    credentials = schema.parse(
      [
        { username: "alice", displayName: "Alice", role: "member" },
        { username: "bob", displayName: "Bob", role: "member" },
        { username: "admin", displayName: "Administrator", role: "admin" },
        { username: "auditor", displayName: "Auditor", role: "auditor" },
      ].map((c) => ({
        ...c,
        id: randomUUID(),
        password: randomBytes(18).toString("base64url"),
      })),
    );
    // Refuse to overwrite an existing credential file, even in concurrent setup.
    await writeFile(file, JSON.stringify(credentials, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
}
await chmod(file, 0o600);
const db = new Database(databasePath);
try {
  db.pragma("foreign_keys=ON");
  db.pragma("journal_mode=WAL");
  migrate(db);
  for (const c of credentials) {
    const existing = db
      .prepare(
        "SELECT id,password_salt,password_hash FROM account_users WHERE username=?",
      )
      .get(c.username) as
      | { id: string; password_salt: string; password_hash: string }
      | undefined;
    if (existing) {
      const matches =
        (
          await accountPasswordHash(c.password, existing.password_salt)
        ).toString("hex") === existing.password_hash;
      if (existing.id !== c.id || !matches)
        throw new Error(
          "Existing account differs from the saved credentials; no account was replaced.",
        );
      continue;
    }
    const salt = randomBytes(16).toString("hex"),
      passwordHash = (await accountPasswordHash(c.password, salt)).toString(
        "hex",
      );
    db.prepare(
      `INSERT INTO account_users(id,username,display_name,role,password_salt,password_hash,balance_cents)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(username) DO NOTHING`,
    ).run(
      c.id,
      c.username,
      c.displayName,
      c.role,
      salt,
      passwordHash,
      c.role === "member" ? 100000 : 0,
    );
  }
  console.log(
    "Accounts ready: alice, bob (Member), admin (Admin), auditor (Auditor).",
  );
  console.log(
    "Passwords are saved only in " +
      file +
      ". Open it locally; do not commit it.",
  );
  console.log(
    "Existing balances, passwords and suspension status are preserved. Run pnpm dev:accounts, then open /accounts.",
  );
} finally {
  db.close();
}
