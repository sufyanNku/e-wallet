import { openDB, type IDBPDatabase } from "idb";
const connections = new Map<string, Promise<IDBPDatabase>>();
// Open only after the Worker has created the versioned database. The host uses
// public stores; vault access is confined to wallet-core in the Worker.
export async function publicStore(mode: "local" | "testnet") {
  const name = `ewallet-v1-${mode}`;
  if (!connections.has(name)) connections.set(name, openDB(name, 1));
  const db = await connections.get(name)!;
  const allowed = new Set([
    "contacts",
    "preferences",
    "permissions",
  ]);
  return {
    async uiPreference<T>(key:string,fallback:T){if(!/^ui:[a-zA-Z]{1,50}$/.test(key))throw new Error('Unknown UI preference');return(await db.get('preferences',key)??fallback)as T;},
    async setUiPreference(key:string,value:boolean){if(!/^ui:[a-zA-Z]{1,50}$/.test(key))throw new Error('Unknown UI preference');await db.put('preferences',value,key);},
    async get(key: string) {
      if (!allowed.has(key)) throw new Error("Unknown public store");
      return db.getAll(key);
    },
    async replace(key: string, values: Array<{ id: string }>) {
      if (!allowed.has(key)) throw new Error("Unknown public store");
      const tx = db.transaction(key, "readwrite");
      await tx.store.clear();
      for (const value of values) await tx.store.put(value, value.id);
      await tx.done;
    },
  };
}
