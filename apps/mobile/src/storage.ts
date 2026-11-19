import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import type { DeviceStore } from "@ewallet/native-wallet";
const options: SecureStore.SecureStoreOptions = {
  keychainService: "app.ewallet.vault.v1",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
export async function deviceStorage(): Promise<DeviceStore> {
  if (!(await SecureStore.isAvailableAsync()))
    throw new Error(
      "Secure device storage is unavailable. Use the Android or iOS app.",
    );
  const db = await SQLite.openDatabaseAsync("public-wallet-v1.db");
  await db.execAsync(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS public_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);",
  );
  const isVault = (key: string) => key.startsWith("vault.");
  return {
    get: async (key) =>
      isVault(key)
        ? SecureStore.getItemAsync(key, options)
        : ((
            await db.getFirstAsync<{ value: string }>(
              "SELECT value FROM public_state WHERE key=?",
              key,
            )
          )?.value ?? null),
    set: async (key, value) => {
      if (isVault(key)) {
        if (value.length > 2000)
          throw new Error(
            "Encrypted vault exceeds the supported keychain item size.",
          );
        await SecureStore.setItemAsync(key, value, options);
      } else
        await db.runAsync(
          "INSERT INTO public_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          key,
          value,
        );
    },
    remove: async (key) => {
      if (isVault(key)) await SecureStore.deleteItemAsync(key, options);
      else await db.runAsync("DELETE FROM public_state WHERE key=?", key);
    },
  };
}
