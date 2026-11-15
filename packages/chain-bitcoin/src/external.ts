import { z } from "zod";
import {
  WalletError,
  type AccountRef,
  type PreparedOperation,
  type TransactionIntent,
} from "@ewallet/domain";
import {
  bitcoin,
  hex,
  deriveWatchAddress,
  bitcoinPayloadSchema,
  validateReviewedPsbt,
  validateRegtestAddress,
  type BitcoinWatch,
} from "./index";
import type { BitcoinAdapter } from "./adapter";
export async function prepareExternalBitcoin(
  adapter: BitcoinAdapter,
  input: unknown,
  account: AccountRef,
  watch: BitcoinWatch,
  watchId: string,
  reserved: Set<string>,
  origin: string,
  requestId: string,
): Promise<PreparedOperation> {
  const params = z
      .object({
        psbt: z.string().max(100000),
        changeIndex: z.number().int().min(0).max(999).optional(),
      })
      .strict()
      .parse(input),
    psbt = bitcoin.Psbt.fromBase64(params.psbt, {
      network: bitcoin.networks.regtest,
    }),
    state = await adapter.refresh(watch, watchId);
  if (
    psbt.inputCount < 1 ||
    psbt.inputCount > 10 ||
    psbt.txOutputs.length < 1 ||
    psbt.txOutputs.length > 2
  )
    throw new WalletError(
      "PSBT_POLICY",
      "Use 1–10 owned confirmed inputs, one recipient and at most one internal change output.",
    );
  const seen = new Set<string>(),
    inputs = psbt.txInputs.map((i) => {
      const id = hex(new Uint8Array(i.hash).reverse()) + ":" + i.index,
        utxo = state.utxos.find((u) => u.txid + ":" + u.vout === id);
      if (
        !utxo ||
        seen.has(id) ||
        reserved.has(id) ||
        BigInt(utxo.confirmations) < 1n
      )
        throw new WalletError(
          "UTXO_POLICY",
          "Every input must be a distinct, unreserved confirmed UTXO in the consented account.",
        );
      seen.add(id);
      return utxo;
    });
  const recipient = bitcoin.address.fromOutputScript(
      psbt.txOutputs[0].script,
      bitcoin.networks.regtest,
    ),
    destination = validateRegtestAddress(recipient),
    amount = psbt.txOutputs[0].value,
    changeIndex = params.changeIndex ?? 0,
    change = psbt.txOutputs[1]?.value ?? 0n;
  if (
    amount < destination.dust ||
    (psbt.txOutputs.length === 2 &&
      (params.changeIndex === undefined ||
        change <
          validateRegtestAddress(
            deriveWatchAddress(watch, 1, changeIndex).address,
          ).dust))
  )
    throw new WalletError(
      "PSBT_OUTPUT",
      "Recipient and change must meet dust policy; change requires an explicit, independently verified internal index.",
    );
  const total = inputs.reduce((sum, u) => sum + BigInt(u.value), 0n),
    fee = total - amount - change,
    estimatedVbytes =
      11n +
      BigInt(inputs.length) * (watch.purpose === 84 ? 69n : 58n) +
      BigInt(destination.outputBytes) +
      (change > 0n
        ? BigInt(
            validateRegtestAddress(
              deriveWatchAddress(watch, 1, changeIndex).address,
            ).outputBytes,
          )
        : 0n),
    feeRate = (fee + estimatedVbytes - 1n) / estimatedVbytes;
  const payload = bitcoinPayloadSchema.parse({
    family: "bitcoin",
    genesisHash: state.genesisHash,
    ledgerFingerprint: state.ledgerFingerprint,
    watch,
    watchId,
    psbt: params.psbt,
    inputs,
    recipient,
    amount: String(amount),
    change: String(change),
    changeIndex,
    fee: String(fee),
    feeRate: String(feeRate),
    estimatedVbytes: String(estimatedVbytes),
  });
  validateReviewedPsbt(payload);
  const intent: TransactionIntent = {
      requestId,
      origin,
      accountId: account.id,
      networkId: adapter.networkId,
      kind: "send",
      recipient,
      asset: {
        networkId: adapter.networkId,
        standard: "native",
        reference: "native",
      },
      amount: String(amount),
    },
    now = Date.now(),
    expiresAt = now + 60000,
    digest = hex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify({ intent, payload, expiresAt }),
          ),
        ),
      ),
    );
  return {
    id: crypto.randomUUID(),
    intent,
    encodedPayload: JSON.stringify(payload),
    preview: {
      sender: account.address,
      title: "Dapp PSBT",
      recipient,
      amount: String(amount),
      assetSymbol: "BTC",
      decimals: 8,
      warnings: [
        "Signing authorizes the supplied transaction. Every input and output is verified; the signed PSBT is returned only to this requesting origin.",
      ],
      decodedOperation: `${inputs.length} owned ${watch.purpose === 84 ? "P2WPKH" : "P2TR"} inputs. Recipient ${amount} satoshis to ${recipient}. ${change > 0n ? `Internal change ${change} satoshis to ${deriveWatchAddress(watch, 1, changeIndex).address} at ${deriveWatchAddress(watch, 1, changeIndex).path}.` : "No change output."} Fee ${fee} satoshis. Sighash ${watch.purpose === 84 ? "ALL" : "DEFAULT"}.`,
    },
    fee: {
      estimated: String(fee),
      maximum: String(fee),
      symbol: "BTC",
      decimals: 8,
    },
    createdAt: now,
    expiresAt,
    fingerprint: `bitcoin:regtest:${account.address}:${Array.from(seen).join(",")}`,
    digest,
    source: "node",
  };
}
