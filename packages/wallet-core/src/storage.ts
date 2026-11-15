import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { type AccountRef, WalletError } from "@ewallet/domain";
import { parseEnvelope, type VaultEnvelope } from "./vault";
interface WalletDB extends DBSchema {
  vault: { key: string; value: VaultEnvelope };
  accounts: { key: string; value: AccountRef };
  preferences: { key: string; value: unknown };
  contacts: { key: string; value: unknown };
  permissions: { key: string; value: unknown };
  journal: { key: string; value: unknown };
  migrations: { key: string; value: unknown };
  leases: { key: string; value: { owner: string; expiresAt: number } };
}
export class VaultStore {
  private db: Promise<IDBPDatabase<WalletDB>>;
  constructor(
    readonly mode: "local" | "testnet",
    private name = `ewallet-v1-${mode}`,
  ) {
    this.db = openDB<WalletDB>(name, 1, {
      upgrade(db) {
        for (const store of [
          "vault",
          "accounts",
          "preferences",
          "contacts",
          "permissions",
          "journal",
          "migrations",
          "leases",
        ] as const)
          db.createObjectStore(store);
      },
      blocked() {
        throw new WalletError(
          "STORAGE_BLOCKED",
          "Close other wallet tabs before updating storage.",
        );
      },
    });
  }
  async envelope() {
    return (await this.db).get("vault", "root");
  }
  async accounts() {
    return (await this.db).getAll("accounts");
  }
  async saveAccounts(accounts: AccountRef[]) {
    const db = await this.db,
      tx = db.transaction("accounts", "readwrite");
    for (const a of accounts) await tx.store.put(a, a.id);
    await tx.done;
  }
  async preference<T>(key: string, fallback: T) {
    return ((await (await this.db).get("preferences", key)) ?? fallback) as T;
  }
  async setPreference(key: string, value: unknown) {
    await (await this.db).put("preferences", value, key);
  }
  async journal<T>(id: string): Promise<T | undefined> {
    return (await (await this.db).get("journal", id)) as T | undefined;
  }
  async updateJournal<T>(id: string, update: (current: T | undefined) => T) {
    const db = await this.db,
      tx = db.transaction("journal", "readwrite");
    try {
      const current = (await tx.store.get(id)) as T | undefined;
      const next = update(current);
      await tx.store.put(next, id);
      await tx.done;
      return next;
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* Already aborted. */
      }
      await tx.done.catch(() => {});
      throw e;
    }
  }
  async exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const key = `${this.name}:${name}`;
    if (typeof navigator !== "undefined" && navigator.locks)
      return navigator.locks.request(key, { mode: "exclusive" }, fn);
    const db = await this.db,
      owner = crypto.randomUUID();
    const tx = db.transaction("leases", "readwrite"),
      lease = await tx.store.get(key);
    if (lease && lease.expiresAt > Date.now()) {
      await tx.done;
      throw new WalletError(
        "BUSY",
        "Another wallet window is updating this data. Try again.",
        true,
      );
    }
    await tx.store.put({ owner, expiresAt: Date.now() + 30000 }, key);
    await tx.done;
    const renew = setInterval(() => {
      void (async () => {
        const t = db.transaction("leases", "readwrite");
        if ((await t.store.get(key))?.owner === owner)
          await t.store.put({ owner, expiresAt: Date.now() + 30000 }, key);
        await t.done;
      })();
    }, 10000);
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      const t = db.transaction("leases", "readwrite");
      if ((await t.store.get(key))?.owner === owner) await t.store.delete(key);
      await t.done;
    }
  }
  async commit(
    envelope: VaultEnvelope,
    expectedRevision: number | null,
    accounts?: AccountRef[],
    rollback = false,
  ) {
    parseEnvelope(envelope);
    return this.exclusive("vault-write", async () => {
      const db = await this.db,
        tx = db.transaction(["vault", "accounts"], "readwrite");
      const current = await tx.objectStore("vault").get("root");
      if ((current?.revision ?? null) !== expectedRevision) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new WalletError(
          "REVISION_CONFLICT",
          "Wallet data changed in another window. Unlock again.",
        );
      }
      if (current && rollback)
        await tx.objectStore("vault").put(current, "rollback");
      await tx.objectStore("vault").put(envelope, "root");
      if (accounts) {
        await tx.objectStore("accounts").clear();
        for (const a of accounts) await tx.objectStore("accounts").put(a, a.id);
      }
      await tx.done;
    });
  }
  async reset(expectedRevision: number) {
    return this.exclusive("vault-write", async () => {
      const db = await this.db,
        tx = db.transaction(
          [
            "vault",
            "accounts",
            "preferences",
            "contacts",
            "permissions",
            "journal",
            "migrations",
          ],
          "readwrite",
        );
      if (
        (await tx.objectStore("vault").get("root"))?.revision !==
        expectedRevision
      ) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new WalletError(
          "REVISION_CONFLICT",
          "Wallet changed in another window.",
        );
      }
      for (const name of tx.objectStoreNames)
        await tx.objectStore(name).clear();
      await tx.done;
    });
  }
  async close() {
    (await this.db).close();
  }
  async permissions(){return(await this.db).getAll('permissions');}
  async savePermission<T extends{id:string}>(permission:T){await(await this.db).put('permissions',permission,permission.id);}
  async allJournal() {
    return (await this.db).getAll("journal");
  }
}
