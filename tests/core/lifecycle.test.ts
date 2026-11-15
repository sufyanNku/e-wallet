import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { WalletCore } from "../../packages/wallet-core/src/core";
import { VaultStore } from "../../packages/wallet-core/src/storage";
import { seal, unseal } from "../../packages/wallet-core/src/vault";
import { importSecret } from "../../packages/wallet-core/src/derivation";
import type { WorkerMethod, WorkerPayload } from "@ewallet/domain/protocol";
import vectors from "../../fixtures/derivation-vectors.json";
const password = "Test-only password with spaces",
  next = "Different test-only password";
function setup(clock?: () => number) {
  const store = new VaultStore("local", `test-${crypto.randomUUID()}`),
    core = new WalletCore(store, "local", clock);
  return { store, core };
}
async function call<M extends WorkerMethod>(
  core: WalletCore,
  method: M,
  payload: WorkerPayload<M>,
) {
  const r = await core.dispatch({
    protocolVersion: 1,
    id: crypto.randomUUID(),
    method,
    payload,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
}
async function imported(core: WalletCore) {
  return call(core, "vault.import", {
    mnemonic: vectors.mnemonic,
    password,
    confirmation: password,
    passphrase: "",
  });
}
describe("Worker lifecycle and storage transactions", () => {
  it("persists only ciphertext and public metadata; each new Worker starts locked", async () => {
    const { store, core } = setup();
    await imported(core);
    const e = (await store.envelope())!;
    expect(JSON.stringify(e)).not.toContain("abandon");
    expect((await store.accounts()).length).toBe(4);
    const fresh = new WalletCore(store, "local");
    expect((await fresh.status()).locked).toBe(true);
    await call(fresh, "vault.unlock", { password });
    expect(
      (await fresh.status()).accounts.find((a) => a.family === "evm")!.address,
    ).toBe(vectors.accounts[0].address);
    await call(fresh, "vault.lock", { reason: "Test" });
    await expect(
      call(fresh, "vault.revealRecovery", { password }),
    ).rejects.toThrow("Unlock");
    await store.close();
  });
  it("verifies password changes, preserves rollback and rejects concurrent revision writes", async () => {
    const { store, core } = setup();
    await imported(core);
    const old = (await store.envelope())!;
    await call(core, "vault.changePassword", {
      current: password,
      next,
      confirmation: next,
    });
    const changed = (await store.envelope())!;
    expect(changed.revision).toBe(old.revision + 1);
    await expect(unseal(changed, password)).rejects.toThrow();
    expect((await unseal(changed, next)).entropyHex).toBe(
      importSecret(vectors.mnemonic).entropyHex,
    );
    const replacement = await seal(importSecret(vectors.mnemonic), next, {
      ...changed,
      revision: changed.revision + 1,
    });
    await expect(store.commit(replacement, old.revision)).rejects.toThrow(
      "another window",
    );
    const fresh = new WalletCore(store, "local");
    await call(fresh, "vault.unlock", { password: next });
    expect((await fresh.status()).locked).toBe(false);
    await store.close();
  });
  it("enforces idle and hidden deadlines even without timer callbacks", async () => {
    let now = Date.now();
    const { core, store } = setup(() => now);
    await imported(core);
    await call(core, "session.settings", { autoLockMinutes: 1 });
    now += 60001;
    await expect(
      call(core, "vault.revealRecovery", { password }),
    ).rejects.toThrow("Unlock");
    await call(core, "vault.unlock", { password });
    await call(core, "session.visibility", { hidden: true });
    now += 60001;
    await call(core, "session.visibility", { hidden: false });
    expect((await core.status()).locked).toBe(true);
    await store.close();
  });
  it("exports and restores encrypted envelopes with validated public derivation metadata", async () => {
    const { store, core } = setup();
    await imported(core);
    const backup = (await call(core, "vault.exportEncrypted", {
      password,
    })) as string;
    expect(backup).not.toContain("abandon");
    const { store: other, core: restored } = setup();
    await call(restored, "vault.restoreEncrypted", {
      envelopeJson: backup,
      password,
      acknowledged: true,
    });
    expect((await restored.status()).accounts.map((a) => a.address)).toEqual(
      (await core.status()).accounts.map((a) => a.address),
    );
    const tampered = JSON.parse(backup);
    tampered.accounts[0].address = "0x0000000000000000000000000000000000000000";
    const bad = setup();
    await expect(
      call(bad.core, "vault.restoreEncrypted", {
        envelopeJson: JSON.stringify(tampered),
        password,
        acknowledged: true,
      }),
    ).rejects.toThrow("metadata");
    await Promise.all([store.close(), other.close(), bad.store.close()]);
  });
  it("does not claim successful storage if a quota/write fails", async () => {
    const { core, store } = setup();
    const original = store.commit.bind(store);
    store.commit = async () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
    await expect(imported(core)).rejects.toThrow("could not be completed");
    expect(await store.envelope()).toBeUndefined();
    expect((await core.status()).locked).toBe(true);
    store.commit = original;
    await store.close();
  });
  it("slows repeated failures without deleting encrypted data", async () => {
    let now = Date.now();
    const { core, store } = setup(() => now);
    await imported(core);
    await call(core, "vault.lock", { reason: "Test" });
    await expect(
      call(core, "vault.unlock", { password: "wrong long password" }),
    ).rejects.toThrow("Unable to unlock");
    await expect(call(core, "vault.unlock", { password })).rejects.toThrow(
      "Wait",
    );
    now += 500;
    await call(core, "vault.unlock", { password });
    expect(await store.envelope()).toBeDefined();
    await store.close();
  });
});
