import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { WalletCore } from "../../packages/wallet-core/src/core";
import { VaultStore } from "../../packages/wallet-core/src/storage";
import { ApprovalLedger } from "../../packages/wallet-core/src/approvals";
import { operationFixture } from "../helpers/operation";
import { redact } from "../../packages/domain/src/redaction";
import vectors from "../../fixtures/derivation-vectors.json";
describe("bounded messages and single-use approval", () => {
  it("rejects unknown methods, malformed payloads, repeated IDs and oversized requests", async () => {
    const store = new VaultStore("local", `security-${crypto.randomUUID()}`),
      core = new WalletCore(store, "local");
    const base = {
      protocolVersion: 1,
      id: crypto.randomUUID(),
      method: "session.status",
      payload: {},
    };
    expect((await core.dispatch({ ...base, method: "signBytes" })).ok).toBe(
      false,
    );
    expect(
      (await core.dispatch({ ...base, payload: { seed: "never accepted" } }))
        .ok,
    ).toBe(false);
    expect((await core.dispatch(base)).ok).toBe(true);
    const duplicate = await core.dispatch(base);
    expect(duplicate.ok ? null : duplicate.error.code).toBe(
      "DUPLICATE_REQUEST",
    );
    expect(
      (
        await core.dispatch({
          ...base,
          id: crypto.randomUUID(),
          payload: { text: "a".repeat(140000) },
        })
      ).ok,
    ).toBe(false);
    await store.close();
  });
  it("binds approval to digest, network, account, expiry, immutable payload and session", async () => {
    const op = operationFixture();
    let now = Date.now();
    const ledger = new ApprovalLedger(undefined, () => now);
    ledger.register(op);
    op.intent.amount = "999";
    expect(ledger.review(op.id).intent.amount).toBe("1");
    expect(() =>
      ledger.approve(op.id, "0".repeat(64), op.intent.accountId, op.intent.networkId),
    ).toThrow("changed");
    expect(() =>
      ledger.approve(op.id, op.digest, op.intent.accountId, "eip155:1"),
    ).toThrow();
    expect(() => ledger.consume(op.id)).toThrow("Explicit");
    ledger.approve(op.id, op.digest, op.intent.accountId, op.intent.networkId);
    ledger.consume(op.id);
    expect(() => ledger.consume(op.id)).toThrow();
    ledger.clear();
    expect(() => ledger.review(op.id)).toThrow("another session");
    op.id = crypto.randomUUID();
    ledger.register(op);
    now = op.expiresAt + 1;
    expect(() =>
      ledger.approve(op.id, op.digest, op.intent.accountId, op.intent.networkId),
    ).toThrow("expired");
  });
  it("sends no secrets to console or fetch during core import/reveal/change/export", async () => {
    const logs = vi.spyOn(console, "log"),
      errors = vi.spyOn(console, "error"),
      network = vi.spyOn(globalThis, "fetch");
    const store = new VaultStore("local", `redaction-${crypto.randomUUID()}`),
      core = new WalletCore(store, "local");
    const request = async (method: string, payload: unknown) =>
      core.dispatch({
        protocolVersion: 1,
        id: crypto.randomUUID(),
        method,
        payload,
      });
    try {
      const password = "Public test-only password";
      expect(
        (
          await request("vault.import", {
            mnemonic: vectors.mnemonic,
            password,
            confirmation: password,
            passphrase: "",
          })
        ).ok,
      ).toBe(true);
      await request("vault.revealRecovery", { password });
      await request("vault.exportEncrypted", { password });
      await request("vault.changePassword", {
        current: password,
        next: "Another public test password",
        confirmation: "Another public test password",
      });
      expect(logs).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(
        JSON.stringify(
          redact({
            mnemonic: vectors.mnemonic,
            password,
            privateKey: "secret",
            signedPayload: "secret",
            safe: "public",
          }),
        ),
      ).not.toContain(vectors.mnemonic);
      await store.close();
    } finally {
      logs.mockRestore();
      errors.mockRestore();
      network.mockRestore();
    }
  });
});
