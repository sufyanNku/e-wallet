import { z } from "zod";
import {
  WalletError,
  type AccountRef,
  type AssetBalance,
  type PreparedOperation,
  type TransactionIntent,
} from "@ewallet/domain";
import { bitcoinWatchRequest, nodeRpc } from "@ewallet/config/rpc";
import {
  REGTEST_GENESIS,
  validateRegtestAddress,
  deriveWatchAddress,
  bitcoinWatchStateSchema,
  bitcoinPayloadSchema,
  selectCoins,
  buildPsbt,
  verifiedUtxo,
  validateReviewedPsbt,
  type BitcoinWatch,
} from "./index";
const raw = z.string().regex(/^[0-9]+$/);
export class BitcoinAdapter {
  readonly networkId = "bitcoin:regtest";
  async identity() {
    const info = z
      .object({
        chain: z.literal("regtest"),
        blocks: raw,
        bestblockhash: z.string(),
      })
      .parse(await nodeRpc(this.networkId, "getblockchaininfo"));
    if (
      (await nodeRpc(this.networkId, "getblockhash", [0])) !== REGTEST_GENESIS
    )
      throw new WalletError(
        "WRONG_NETWORK",
        "Bitcoin genesis differs from regtest.",
      );
    return {
      ...info,
      ledgerFingerprint: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .parse(await nodeRpc(this.networkId, "getblockhash", [1])),
    };
  }
  async register(watch: BitcoinWatch) {
    await this.identity();
    return z
      .object({
        watchId: z.string().regex(/^[0-9a-f]{64}$/),
        historyWatchId:z.string().uuid(),
        genesisHash: z.literal(REGTEST_GENESIS),
      })
      .parse(await bitcoinWatchRequest("watch", { acknowledged: true, watch }));
  }
  async refresh(watch: BitcoinWatch, watchId: string) {
    await this.identity();
    const state = bitcoinWatchStateSchema.parse(
      await bitcoinWatchRequest("utxos", { watchId }),
    );
    for (const utxo of state.utxos) verifiedUtxo(utxo, watch);
    return state;
  }
  async nextAddress(
    watch: BitcoinWatch,
    watchId: string,
    change: 0 | 1,
    minimumIndex: number,
  ) {
    const returned = z
      .object({
        address: z.string(),
        scriptHex: z.string(),
        path: z.string(),
        change: z.union([z.literal(0), z.literal(1)]),
        addressIndex: z.number().int(),
        publicKey: z.string(),
      })
      .parse(
        await bitcoinWatchRequest("address", { watchId, change, minimumIndex }),
      );
    const derived = deriveWatchAddress(watch, change, returned.addressIndex);
    if (
      returned.address !== derived.address ||
      returned.scriptHex !== derived.scriptHex ||
      returned.change !== change ||
      returned.path !== derived.path
    )
      throw new WalletError(
        "DERIVATION",
        "Watch service returned an unexpected derivation.",
      );
    return derived;
  }
  async balances(watch: BitcoinWatch, watchId: string, reserved: Set<string>) {
    const state = await this.refresh(watch, watchId),
      total = state.utxos.reduce((sum, u) => sum + BigInt(u.value), 0n),
      available = state.utxos
        .filter(
          (u) =>
            BigInt(u.confirmations) > 0n &&
            !reserved.has(`${u.txid}:${u.vout}`),
        )
        .reduce((sum, u) => sum + BigInt(u.value), 0n),
      reservation = state.utxos
        .filter((u) => reserved.has(`${u.txid}:${u.vout}`))
        .reduce((sum, u) => sum + BigInt(u.value), 0n);
    const balance: AssetBalance = {
      asset: {
        networkId: this.networkId,
        standard: "native",
        reference: "native",
      },
      raw: String(total),
      available: String(available),
      reserved: String(reservation),
      decimals: 8,
      observation: {
        source: "node",
        networkId: this.networkId,
        observedHeight: state.height,
        observedAt: new Date().toISOString(),
        blockHash: state.blockHash,
      },
      symbol: "BTC",
      name:
        watch.purpose === 84
          ? "Bitcoin Regtest · SegWit"
          : "Bitcoin Regtest · Taproot",
      hidden: false,
      verified: true,
      microUsdRate: null,
      stale: false,
    };
    return { balance, state };
  }
  async prepare(
    intent: TransactionIntent,
    account: AccountRef,
    watch: BitcoinWatch,
    watchId: string,
    reserved: Set<string>,
  ): Promise<PreparedOperation> {
    if (
      intent.kind !== "send" ||
      intent.asset.standard !== "native" ||
      intent.networkId !== this.networkId ||
      intent.accountId !== account.id
    )
      throw new WalletError(
        "UNSUPPORTED_OPERATION",
        "Bitcoin supports reviewed native regtest payments only.",
      );
    validateRegtestAddress(intent.recipient);
    const state = await this.refresh(watch, watchId),
      changeIndex = Math.max(
        0,
        (state.discovery.find((d) => d.change === 1)?.lastUsed ?? -1) + 1,
      ),
      change = await this.nextAddress(watch, watchId, 1, changeIndex);
    const selection = selectCoins(
      state.utxos.filter((u) => !reserved.has(`${u.txid}:${u.vout}`)),
      BigInt(intent.amount),
      intent.recipient,
      change.address,
      watch.purpose,
      BigInt(state.feeRate),
    );
    const payload = bitcoinPayloadSchema.parse({
      family: "bitcoin",
      genesisHash: REGTEST_GENESIS,
      ledgerFingerprint: state.ledgerFingerprint,
      watch,
      watchId,
      psbt: buildPsbt(
        watch,
        selection,
        intent.recipient,
        change.addressIndex,
      ).toBase64(),
      inputs: selection.inputs,
      recipient: intent.recipient,
      amount: intent.amount,
      change: String(selection.change),
      changeIndex: change.addressIndex,
      fee: String(selection.fee),
      feeRate: state.feeRate,
      estimatedVbytes: String(selection.estimatedVbytes),
    });
    validateReviewedPsbt(payload);
    const encodedPayload = JSON.stringify(payload),
      now = Date.now(),
      expiresAt = now + 60000,
      digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify({ intent, payload, expiresAt }),
            ),
          ),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    return {
      id: crypto.randomUUID(),
      intent: structuredClone(intent),
      encodedPayload,
      preview: {
        sender:account.address,
        title: "Bitcoin payment",
        recipient: intent.recipient,
        amount: intent.amount,
        assetSymbol: "BTC",
        decimals: 8,
        warnings: [
          `${state.feeSource}: ${state.feeRate} sat/vByte.`,
          ...(selection.dustToFee > 0n
            ? [
                `${selection.dustToFee} satoshis of dust change are included in the reviewed fee.`,
              ]
            : []),
        ],
        decodedOperation: `${selection.inputs.length} owned ${watch.purpose === 84 ? "P2WPKH" : "P2TR"} input(s); recipient ${intent.amount} satoshis to ${intent.recipient}; ${selection.change > 0n ? `internal change ${selection.change} satoshis to ${change.address} (${change.path})` : "no change output"}; fee ${selection.fee} satoshis. Sighash ${watch.purpose === 84 ? "ALL" : "DEFAULT"}.`,
      },
      fee: {
        estimated: String(selection.fee),
        maximum: String(selection.fee),
        symbol: "BTC",
        decimals: 8,
      },
      createdAt: now,
      expiresAt,
      fingerprint: `${this.networkId}:${account.address}:${selection.inputs.map((u) => u.txid + ":" + u.vout).join(",")}`,
      digest,
      source: "node",
    };
  }
  async revalidate(op: PreparedOperation) {
    const identity = await this.identity();
    const payload = bitcoinPayloadSchema.parse(JSON.parse(op.encodedPayload));
    if (payload.ledgerFingerprint !== identity.ledgerFingerprint)
      throw new WalletError(
        "CHAIN_RESTARTED",
        "The regtest funding epoch changed. Reconcile the new local ledger.",
      );
    validateReviewedPsbt(payload);
    for (const input of payload.inputs) {
      const output = z
        .object({
          value: z.string(),
          scriptPubKey: z.object({ hex: z.string() }),
        })
        .nullable()
        .parse(
          await nodeRpc(this.networkId, "gettxout", [
            input.txid,
            input.vout,
            true,
          ]),
        );
      if (!output || output.scriptPubKey.hex !== input.scriptHex)
        throw new WalletError(
          "UTXO_SPENT",
          "A reviewed input is spent, reserved or has changed.",
        );
      const { satoshis } = await import("./index");
      if (satoshis(output.value) !== input.value)
        throw new WalletError(
          "UTXO_MISMATCH",
          "Node value differs from the reviewed UTXO.",
        );
    }
    return payload;
  }
  async broadcast(signed: string) {
    const acceptance = z
      .array(z.object({ allowed: z.boolean() }))
      .parse(await nodeRpc(this.networkId, "testmempoolaccept", [[signed]]));
    if (acceptance[0]?.allowed !== true)
      throw new WalletError(
        "MEMPOOL_REJECTED",
        "Bitcoin Core refused this transaction. Reconcile its inputs before retrying.",
      );
    return z
      .string()
      .parse(await nodeRpc(this.networkId, "sendrawtransaction", [signed]));
  }
}
export async function bitcoinStatus(txid: string) {
  const network = "bitcoin:regtest";
  let result: unknown;
  try {
    result = await nodeRpc(network, "getrawtransaction", [txid, true]);
  } catch {
    return {
      state: "submission_unknown" as const,
      height: null,
      fee: null,
      blockHash: null,
    };
  }
  const transaction = z
    .object({
      txid: z.string(),
      confirmations: raw.optional(),
      blockhash: z.string().optional(),
    })
    .parse(result);
  if (transaction.txid !== txid)
    throw new WalletError(
      "RPC_RESPONSE",
      "Unexpected Bitcoin transaction identifier.",
    );
  if (!transaction.blockhash)
    return {
      state: "submitted" as const,
      height: null,
      fee: null,
      blockHash: null,
    };
  const header = z
    .object({ height: raw, confirmations: z.string() })
    .parse(
      await nodeRpc(network, "getblockheader", [transaction.blockhash, true]),
    );
  if (BigInt(header.confirmations) < 0n)
    return {
      state: "orphaned" as const,
      height: header.height,
      fee: null,
      blockHash: transaction.blockhash,
    };
  const confirmations = BigInt(transaction.confirmations ?? "0");
  return {
    state:
      confirmations >= 6n
        ? ("confirmed" as const)
        : confirmations >= 1n
          ? ("included" as const)
          : ("submitted" as const),
    height: header.height,
    fee: null,
    blockHash: transaction.blockhash,
  };
}
