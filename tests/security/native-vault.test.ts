import { it, expect } from "vitest";
import {
  encryptNativeSecret,
  decryptNativeSecret,
} from "../../packages/native-wallet/src/vault";
import {
  nativeImport,
  nativeAccount,
  nativeWords,
} from "../../packages/native-wallet/src/keys";
import { nativeBitcoinWatch } from "../../packages/native-wallet/src/bitcoin";
import { readFileSync } from "node:fs";
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const phrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
it("matches independent browser derivation for EVM, Solana and both Bitcoin scripts", () => {
  const vectors = JSON.parse(
    readFileSync("fixtures/derivation-vectors.json", "utf8"),
  );
  const s = nativeImport(phrase);
  expect(nativeWords(s).join(" ")).toBe(phrase);
  const evm = nativeAccount(s, "evm"),
    sol = nativeAccount(s, "solana"),
    btc = nativeAccount(s, "bitcoin"),
    tr = nativeAccount(s, "bitcoin", 0, "p2tr");
  expect(evm.address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  expect(sol.address).toBe("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
  expect(btc.address).toBe(vectors.accounts[2].address);
  expect(tr.address).toBe(vectors.accounts[3].address);
  const watch = nativeBitcoinWatch(s, btc);
  expect(watch.xpub).toMatch(/^tpub/);
  expect(JSON.stringify(watch)).not.toContain(s.entropy);
  expect(() => nativeAccount(s, "evm", -1)).toThrow();
});
it("encrypts a native keychain envelope with authenticated metadata and rejects corruption and wrong passwords", async () => {
  const secret = nativeImport(phrase, "passphrase"),
    a = await encryptNativeSecret(secret, "a unique test password", random),
    b = await encryptNativeSecret(secret, "a unique test password", random);
  expect(a.ciphertext).not.toBe(b.ciphertext);
  expect(JSON.stringify(a)).not.toContain(secret.entropy);
  expect(JSON.stringify(a).length).toBeLessThan(2000);
  expect(
    (await decryptNativeSecret(JSON.stringify(a), "a unique test password"))
      .secret,
  ).toEqual(secret);
  await expect(
    decryptNativeSecret(JSON.stringify(a), "the wrong test password"),
  ).rejects.toThrow("Could not unlock");
  await expect(
    decryptNativeSecret(
      JSON.stringify({ ...a, revision: a.revision + 1 }),
      "a unique test password",
    ),
  ).rejects.toThrow("Could not unlock");
  await expect(
    decryptNativeSecret(
      JSON.stringify({ ...a, iterations: 1 }),
      "a unique test password",
    ),
  ).rejects.toThrow("Could not unlock");
}, 30000);
