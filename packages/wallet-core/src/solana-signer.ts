import { HDKey } from "micro-key-producer/slip10.js";
import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  signTransaction,
  getSignatureFromTransaction,
} from "@solana/kit";
import { WalletError, type AccountRef } from "@ewallet/domain";
import {
  fromBase64,
  toBase64,
  type SolanaPayload,
} from "@ewallet/chain-solana";
import { seedBytes, pathFor } from "./derivation";
import type { VaultSecret } from "./vault";
export async function signReviewedSolana(
  secret: VaultSecret,
  account: AccountRef,
  payload: SolanaPayload,
) {
  if (
    account.family !== "solana" ||
    account.path !== pathFor({ family: "solana", index: account.index }) ||
    account.address !== payload.accountAddress
  )
    throw new WalletError(
      "DERIVATION",
      "Invalid Solana signing path or selected account.",
    );
  const tx = getTransactionDecoder().decode(
      fromBase64(payload.unsignedTransaction),
    ),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (
    (message.version !== 0 && !(payload.external && message.version === "legacy")) ||
    message.staticAccounts[0] !== account.address ||
    message.header.numSignerAccounts !== 1 ||
    message.lifetimeToken !== payload.blockhash ||
    ("addressTableLookups" in message && message.addressTableLookups?.length) ||
    Object.values(tx.signatures).some((signature) => signature !== null)
  )
    throw new WalletError(
      "UNSUPPORTED_MESSAGE",
      "Unsupported Solana message or signer set.",
    );
  const seed = seedBytes(secret),
    root = HDKey.fromMasterSeed(seed),
    child = root.derive(account.path),
    privateBytes = new Uint8Array(child.privateKey);
  try {
    const pair = await createKeyPairFromPrivateKeyBytes(privateBytes);
    if ((await getAddressFromPublicKey(pair.publicKey)) !== account.address)
      throw new WalletError(
        "SIGNER",
        "Derived Solana signer differs from the selected account.",
      );
    const signed = await signTransaction([pair], tx);
    return {
      signed: toBase64(getTransactionEncoder().encode(signed)),
      signature: getSignatureFromTransaction(signed),
    };
  } finally {
    seed.fill(0);
    privateBytes.fill(0);
    root.privateKey.fill(0);
    child.privateKey.fill(0);
  }
}
