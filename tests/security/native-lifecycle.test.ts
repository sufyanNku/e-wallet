import { it, expect } from "vitest";
import { NativeWallet } from "../../packages/native-wallet/src/wallet";
import { NativeApi } from "../../packages/native-wallet/src/api";
import type { DeviceStore } from "../../packages/native-wallet/src/vault";
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const phrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
function memory() {
  const data = new Map<string, string>();
  const store: DeviceStore = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
    },
    remove: async (k) => {
      data.delete(k);
    },
  };
  return { store, data };
}
it("native restore survives restart, rejects signing while locked, and changes its password atomically", async () => {
  const { store, data } = memory(),
    wallet = new NativeWallet(
      store,
      random,
      new NativeApi("http://127.0.0.1:8787"),
    );
  await wallet.open();
  expect(wallet.getSnapshot().initialized).toBe(false);
  await wallet.restore(
    phrase,
    "a private test password",
    "a private test password",
  );
  const account = wallet
    .getSnapshot()
    .accounts.find((a) => a.family === "evm")!;
  expect(account.address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  const stored = JSON.stringify([...data.values()]);
  expect(stored).not.toContain(phrase);
  expect(stored).not.toContain("a private test password");
  wallet.selectNetwork("solana:local");
  wallet.lock();
  await expect(wallet.approve(crypto.randomUUID(), "bad")).rejects.toThrow(
    "locked",
  );
  await wallet.unlock("a private test password");
  expect(
    wallet
      .getSnapshot()
      .accounts.find((a) => a.id === wallet.getSnapshot().selectedAccountId)
      ?.family,
  ).toBe("solana");
  await wallet.changePassword(
    "a private test password",
    "another private test password",
    "another private test password",
  );
  wallet.lock();
  const reopened = new NativeWallet(
    store,
    random,
    new NativeApi("http://127.0.0.1:8787"),
  );
  await reopened.open();
  expect(reopened.getSnapshot().initialized).toBe(true);
  await expect(reopened.unlock("a private test password")).rejects.toThrow(
    "Could not unlock",
  );
  const fresh = new NativeWallet(
    store,
    random,
    new NativeApi("http://127.0.0.1:8787"),
  );
  await fresh.open();
  await fresh.unlock("another private test password");
  expect(
    fresh.getSnapshot().accounts.find((a) => a.family === "evm")?.address,
  ).toBe(account.address);
}, 30000);
it("native locking cancels a pending KDF setup instead of exposing its words", async () => {
  const { store } = memory(),
    wallet = new NativeWallet(
      store,
      random,
      new NativeApi("http://127.0.0.1:8787"),
    );
  await wallet.open();
  const creating = wallet.create(
    "a private test password",
    "a private test password",
  );
  wallet.lock();
  await expect(creating).rejects.toThrow("cancelled");
  expect(wallet.getSnapshot().initialized).toBe(false);
  expect(await store.get("vault.testnet.v1")).toBeNull();
}, 30000);
it("native forgotten-password removal requires confirmation, rejects stale targets and preserves a vault on cleanup failure", async () => {
  const { store, data } = memory();
  const wallet = new NativeWallet(
    store,
    random,
    new NativeApi("http://127.0.0.1:8787"),
  );
  await wallet.open();
  const password = "a private test password";
  await wallet.restore(phrase, password, password);
  const original = await wallet.resetTarget();
  const address = wallet.getSnapshot().accounts[0].address;
  await wallet.changePassword(
    password,
    "another private test password",
    "another private test password",
  );
  wallet.lock();
  await expect(
    wallet.forgetWallet(original, "RESET WALLET", true),
  ).rejects.toThrow("changed");
  const target = await wallet.resetTarget();
  await expect(wallet.forgetWallet(target, "RESET", true)).rejects.toThrow(
    "type RESET WALLET",
  );
  await expect(
    wallet.forgetWallet(target, "RESET WALLET", false),
  ).rejects.toThrow("recovery backup");
  expect(await wallet.resetTarget()).toBe(target);
  const remove = store.remove;
  store.remove = async () => {
    throw new Error("Keychain cleanup failed");
  };
  await expect(
    wallet.forgetWallet(target, "RESET WALLET", true),
  ).rejects.toThrow("cleanup failed");
  expect(data.get("vault.testnet.v1")).toBe(target);
  expect(wallet.getSnapshot().initialized).toBe(true);
  expect(wallet.getSnapshot().locked).toBe(true);
  store.remove = remove;
  await wallet.forgetWallet(target, "RESET WALLET", true);
  expect(wallet.getSnapshot().initialized).toBe(false);
  expect(wallet.getSnapshot().accounts).toEqual([]);
  expect(await store.get("vault.testnet.v1")).toBeNull();
  await wallet.restore(phrase, password, password);
  expect(wallet.getSnapshot().accounts[0].address).toBe(address);
}, 30000);
