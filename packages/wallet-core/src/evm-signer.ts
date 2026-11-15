import { HDKey } from "@scure/bip32";
import { Wallet, Transaction, hexlify, getAddress } from "ethers";
import { WalletError, type AccountRef } from "@ewallet/domain";
import type { EvmPayload } from "@ewallet/chain-evm";
import { seedBytes, pathFor } from "./derivation";
import type { VaultSecret } from "./vault";
// This module is reachable only through wallet-core in the dedicated Worker.
// It accepts a validated, reviewed EVM transaction, never arbitrary sign(bytes).
export async function signReviewedEvm(
  secret: VaultSecret,
  account: AccountRef,
  payload: EvmPayload,
  chainId: string,
) {
  if (
    account.family !== "evm" ||
    account.path !== pathFor({ family: "evm", index: account.index })
  )
    throw new WalletError("DERIVATION", "Unsupported EVM signing path.");
  const transaction = Transaction.from(payload.unsignedTransaction);
  if (transaction.chainId !== BigInt(chainId) || transaction.signature)
    throw new WalletError(
      "WRONG_NETWORK",
      "Invalid reviewed unsigned transaction.",
    );
  const seed = seedBytes(secret),
    root = HDKey.fromMasterSeed(seed),
    child = root.derive(account.path);
  try {
    if (!child.privateKey)
      throw new WalletError("SIGNER", "Unable to derive signer.");
    const signer = new Wallet(hexlify(child.privateKey));
    if (
      getAddress(signer.address) !== getAddress(account.address) ||
      getAddress(payload.accountAddress) !== getAddress(account.address)
    )
      throw new WalletError(
        "SIGNER",
        "Derived signer differs from the approved account.",
      );
    return await signer.signTransaction({
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      nonce: transaction.nonce,
      chainId: transaction.chainId,
      gasLimit: transaction.gasLimit,
      type: transaction.type,
      ...(transaction.type === 2
        ? {
            maxFeePerGas: transaction.maxFeePerGas,
            maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
          }
        : { gasPrice: transaction.gasPrice }),
    });
  } finally {
    seed.fill(0);
    root.wipePrivateData();
    child.wipePrivateData();
  }
}
