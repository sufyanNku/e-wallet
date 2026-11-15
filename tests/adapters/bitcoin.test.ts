import { it, expect } from "vitest";
import fc from "fast-check";
import {
  importSecret,
  derivePublic,
  bitcoinPublicWatch,
} from "../../packages/wallet-core/src/derivation";
import {
  deriveWatchAddress,
  publicDescriptor,
  selectCoins,
  validateRegtestAddress,
  bitcoin,
  type BitcoinUtxo,
} from "@ewallet/chain-bitcoin";
const secret = importSecret(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
for (const type of ["p2wpkh", "p2tr"] as const)
  it(
    "matches independent " +
      type +
      " recovery vector and never emits private descriptors",
    () => {
      const account = derivePublic(secret, "vector", {
          family: "bitcoin",
          index: 0,
          bitcoinType: type,
        }),
        watch = bitcoinPublicWatch(secret, account);
      expect(deriveWatchAddress(watch, 0, 0).address).toBe(account.address);
      expect(watch.xpub.startsWith("tpub")).toBe(true);
      expect(publicDescriptor(watch, 0)).not.toMatch(/prv/);
      expect(deriveWatchAddress(watch, 1, 0).address).not.toBe(account.address);
    },
  );
it("rejects a mainnet destination and nonwitness scripts", () => {
  expect(() =>
    validateRegtestAddress("bc1q6rz28mcfaxtmd6v789l9rrlrusdprr9p5fz4s5"),
  ).toThrow("regtest");
  expect(() =>
    validateRegtestAddress(
      bitcoin.payments.p2pkh({
        hash: new Uint8Array(20),
        network: bitcoin.networks.regtest,
      }).address!,
    ),
  ).toThrow("regtest");
});
it("preserves input/output/fee arithmetic and never selects an unconfirmed coin", () => {
  const account = derivePublic(secret, "vector", {
      family: "bitcoin",
      index: 0,
      bitcoinType: "p2wpkh",
    }),
    watch = bitcoinPublicWatch(secret, account),
    change = deriveWatchAddress(watch, 1, 0).address;
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 10000, max: 1000000 }), {
        minLength: 1,
        maxLength: 8,
      }),
      fc.integer({ min: 294, max: 5000 }),
      (values, amount) => {
        const coins = values.map(
          (value, index) =>
            ({
              txid: index.toString(16).padStart(64, "0"),
              vout: 0,
              value: String(value),
              confirmations: "6",
            }) as BitcoinUtxo,
        );
        coins.push({
          txid: "f".repeat(64),
          vout: 0,
          value: "999999999",
          confirmations: "0",
        } as BitcoinUtxo);
        const selected = selectCoins(
            coins,
            BigInt(amount),
            account.address,
            change,
            84,
            2n,
          ),
          total = selected.inputs.reduce((sum, i) => sum + BigInt(i.value), 0n);
        expect(total).toBe(BigInt(amount) + selected.change + selected.fee);
        expect(selected.inputs.every((i) => i.confirmations !== "0")).toBe(
          true,
        );
        expect(selected.inputs.length).toBeLessThanOrEqual(10);
        expect(selected.change === 0n || selected.change >= 294n).toBe(true);
      },
    ),
  );
});
// These are deliberately synthetic previous transactions, separate from the
// Core mempool evidence produced by scripts/check-bitcoin-psbt.ts.
it("rejects hidden outputs, forged input values and noninternal change in reviewed PSBTs", async () => {
  const { bitcoinPayloadSchema, buildPsbt, validateReviewedPsbt, hex } =
    await import("@ewallet/chain-bitcoin");
  const account = derivePublic(secret, "vector", {
      family: "bitcoin",
      index: 0,
      bitcoinType: "p2wpkh",
    }),
    watch = bitcoinPublicWatch(secret, account),
    own = deriveWatchAddress(watch, 0, 0),
    change = deriveWatchAddress(watch, 1, 0),
    recipient = deriveWatchAddress(watch, 0, 1).address;
  const previous = new bitcoin.Transaction();
  previous.addInput(new Uint8Array(32).fill(1), 0);
  previous.addOutput(
    bitcoin.address.toOutputScript(own.address, bitcoin.networks.regtest),
    50000n,
  );
  const coin: BitcoinUtxo = {
      txid: previous.getId(),
      vout: 0,
      value: "50000",
      scriptHex: own.scriptHex,
      confirmations: "6",
      path: own.path,
      change: 0,
      addressIndex: 0,
      address: own.address,
      rawTransaction: previous.toHex(),
    },
    selection = selectCoins([coin], 10000n, recipient, change.address, 84, 2n);
  const payload = bitcoinPayloadSchema.parse({
    family: "bitcoin",
    genesisHash:
      "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
    ledgerFingerprint: "0".repeat(64),
    watch,
    watchId: "0".repeat(64),
    psbt: buildPsbt(watch, selection, recipient, 0).toBase64(),
    inputs: [coin],
    recipient,
    amount: "10000",
    change: String(selection.change),
    changeIndex: 0,
    fee: String(selection.fee),
    feeRate: "2",
    estimatedVbytes: String(selection.estimatedVbytes),
  });
  expect(() => validateReviewedPsbt(payload)).not.toThrow();
  const hidden = bitcoin.Psbt.fromBase64(payload.psbt, {
    network: bitcoin.networks.regtest,
  });
  hidden.addOutput({ address: recipient, value: 1n });
  expect(() =>
    validateReviewedPsbt({ ...payload, psbt: hidden.toBase64() }),
  ).toThrow("outputs");
  expect(() =>
    validateReviewedPsbt({ ...payload, inputs: [{ ...coin, value: "50001" }] }),
  ).toThrow("Referenced output");
  expect(() => validateReviewedPsbt({ ...payload, changeIndex: 1 })).toThrow(
    "internal",
  );
  const noninternal = bitcoin.Psbt.fromBase64(payload.psbt, {
    network: bitcoin.networks.regtest,
  });
  noninternal.data.inputs[0].sighashType=bitcoin.Transaction.SIGHASH_NONE;
  expect(() =>
    validateReviewedPsbt({ ...payload, psbt: noninternal.toBase64() }),
  ).toThrow("authorization");
  expect(hex(previous.outs[0].script)).toBe(own.scriptHex);
});
