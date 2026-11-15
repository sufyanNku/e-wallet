import { describe, it, expect } from "vitest";
import {
  seal,
  unseal,
  parseEnvelope,
} from "../../packages/wallet-core/src/vault";
import {
  createSecret,
  importSecret,
  derivePublic,
  initialAccounts,
  recoveryWords,
} from "../../packages/wallet-core/src/derivation";
import vectors from "../../fixtures/derivation-vectors.json";
const password = "Test-only password with spaces";
describe("encrypted vault", () => {
  it("uses fresh salt/IV, authenticated parameters and exact passwords", async () => {
    const secret = importSecret(vectors.mnemonic);
    const a = await seal(secret, password),
      b = await seal(secret, password);
    expect(a.kdf.iterations).toBe(600000);
    expect(a.kdf.saltBase64).not.toBe(b.kdf.saltBase64);
    expect(a.cipher.ivBase64).not.toBe(b.cipher.ivBase64);
    expect(a.cipher.ciphertextBase64).not.toBe(b.cipher.ciphertextBase64);
    expect(await unseal(a, password)).toEqual(secret);
    await expect(unseal(a, password + " ")).rejects.toThrow("Unable to unlock");
    await expect(
      unseal({ ...a, revision: a.revision + 1 }, password),
    ).rejects.toThrow("Unable to unlock");
    const tampered = structuredClone(a);
    tampered.cipher.ciphertextBase64 =
      "AAAA" + tampered.cipher.ciphertextBase64.slice(4);
    await expect(unseal(tampered, password)).rejects.toThrow(
      "Unable to unlock",
    );
  });
  it("rejects unbounded KDFs, noncanonical base64 and invalid backup shapes before deriving", async () => {
    const e = await seal(importSecret(vectors.mnemonic), password);
    expect(() =>
      parseEnvelope({ ...e, kdf: { ...e.kdf, iterations: 600000000 } }),
    ).toThrow();
    expect(() =>
      parseEnvelope({
        ...e,
        cipher: { ...e.cipher, ivBase64: "!!!!!!!!!!!!====" },
      }),
    ).toThrow();
    expect(() => parseEnvelope({ ...e, plaintext: "no" })).toThrow();
    await expect(seal(importSecret(vectors.mnemonic), "short")).rejects.toThrow(
      "12 characters",
    );
  });
  it("creates 256-bit random entropy and validates 12/24-word checksums", () => {
    const a = createSecret(),
      b = createSecret();
    expect(a.entropyHex).toHaveLength(64);
    expect(a.entropyHex).not.toBe(b.entropyHex);
    expect(recoveryWords(a)).toHaveLength(24);
    expect(importSecret(recoveryWords(a).join(" "))).toEqual(a);
    expect(() => importSecret("abandon ".repeat(12))).toThrow("checksum");
    expect(() => importSecret(vectors.mnemonic + " abandon")).toThrow();
  });
});
describe("independently calculated recovery vectors", () => {
  it("matches EVM, hardened Solana, SegWit and key-path Taproot", () => {
    const accounts = initialAccounts(
      importSecret(vectors.mnemonic),
      "vector-wallet",
    );
    for (const vector of vectors.accounts) {
      const actual = accounts.find(
        (a) => a.family === vector.family && a.path === vector.path,
      );
      expect(actual?.address).toBe(vector.address);
    }
  });
  it("keeps supported paths and passphrases isolated", () => {
    const a = importSecret(vectors.mnemonic),
      b = importSecret(vectors.mnemonic, "different");
    expect(derivePublic(a, "a", { family: "evm", index: 0 }).address).not.toBe(
      derivePublic(b, "b", { family: "evm", index: 0 }).address,
    );
    expect(
      derivePublic(a, "a", { family: "solana", index: 1 }).address,
    ).not.toBe(derivePublic(a, "a", { family: "solana", index: 0 }).address);
    expect(() =>
      derivePublic(a, "a", { family: "bitcoin", index: -1 }),
    ).toThrow();
    expect(
      derivePublic(importSecret(vectors.mnemonic, "é"), "a", {
        family: "evm",
        index: 0,
      }).address,
    ).toBe(
      derivePublic(importSecret(vectors.mnemonic, "e\u0301"), "a", {
        family: "evm",
        index: 0,
      }).address,
    );
  });
});
