import { HDKey } from "@scure/bip32";
import { WalletError, type AccountRef } from "@ewallet/domain";
import {
  bitcoin,
  ecc,
  hex,
  deriveWatchAddress,
  validateReviewedPsbt,
  type BitcoinPayload,
} from "@ewallet/chain-bitcoin";
import { seedBytes, bitcoinPublicWatch } from "./derivation";
import type { VaultSecret } from "./vault";
export function signReviewedBitcoin(
  secret: VaultSecret,
  account: AccountRef,
  payload: BitcoinPayload,
) {
  const publicWatch = bitcoinPublicWatch(secret, account);
  if (JSON.stringify(publicWatch) !== JSON.stringify(payload.watch))
    throw new WalletError(
      "SIGNER",
      "Reviewed Bitcoin account differs from the derived public descriptor.",
    );
  const psbt = validateReviewedPsbt(payload),
    seed = seedBytes(secret),
    root = HDKey.fromMasterSeed(seed);
  try {
    for (let index = 0; index < payload.inputs.length; index++) {
      const input = payload.inputs[index],
        child = root.derive(input.path);
      let key: Uint8Array | null = null;
      try {
        if (!child.privateKey || !child.publicKey)
          throw new WalletError("SIGNER", "Unable to derive input signer.");
        key = new Uint8Array(child.privateKey);
        if (payload.watch.purpose === 86) {
          if (child.publicKey[0] === 3) {
            const negated = ecc.privateNegate(key);
            key.fill(0);
            key = negated;
          }
          const tweak = bitcoin.crypto.taggedHash(
              "TapTweak",
              child.publicKey.slice(1),
            ),
            tweaked = ecc.privateAdd(key, tweak);
          key.fill(0);
          key = tweaked;
          if (!key) throw new WalletError("SIGNER", "Invalid Taproot tweak.");
        }
        const publicKey = ecc.pointFromScalar(key);
        if (!publicKey)
          throw new WalletError("SIGNER", "Invalid input signer.");
        const signingKey = key;
        psbt.signInput(index, {
          publicKey,
          sign: (hash) => ecc.sign(hash, signingKey),
          signSchnorr: (hash) => ecc.signSchnorr(hash, signingKey),
        });
      } finally {
        key?.fill(0);
        child.wipePrivateData();
      }
    }
    if (
      !psbt.validateSignaturesOfAllInputs((publicKey, hash, signature) =>
        publicKey.length === 32
          ? ecc.verifySchnorr(hash, publicKey, signature)
          : ecc.verify(hash, publicKey, signature),
      )
    )
      throw new WalletError("SIGNATURE", "PSBT signature verification failed.");
    psbt.finalizeAllInputs();
    const transaction = psbt.extractTransaction();
    if (
      transaction.ins.length !== payload.inputs.length ||
      transaction.outs.length !== (BigInt(payload.change) > 0n ? 2 : 1) ||
      hex(transaction.outs[0].script) !==
        hex(
          bitcoin.address.toOutputScript(
            payload.recipient,
            bitcoin.networks.regtest,
          ),
        ) ||
      transaction.outs[0].value !== BigInt(payload.amount) ||
      transaction.virtualSize() > Number(payload.estimatedVbytes)
    )
      throw new WalletError(
        "TRANSACTION_CHANGED",
        "Final transaction differs from the reviewed inputs, outputs or size bound.",
      );
    for (let i = 0; i < transaction.ins.length; i++) {
      const input = transaction.ins[i],
        expected = payload.inputs[i];
      if (
        hex(new Uint8Array(input.hash).reverse()) !== expected.txid ||
        input.index !== expected.vout
      )
        throw new WalletError(
          "TRANSACTION_CHANGED",
          "Final transaction input changed.",
        );
    }
    if (
      BigInt(payload.change) > 0n &&
      (transaction.outs[1].value !== BigInt(payload.change) ||
        hex(transaction.outs[1].script) !==
          deriveWatchAddress(payload.watch, 1, payload.changeIndex).scriptHex)
    )
      throw new WalletError(
        "TRANSACTION_CHANGED",
        "Final change amount changed.",
      );
    return {
      signed: transaction.toHex(),
      txid: transaction.getId(),
      virtualSize: transaction.virtualSize(),
      psbt: psbt.toBase64(),
    };
  } finally {
    seed.fill(0);
    root.wipePrivateData();
  }
}
