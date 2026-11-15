import { z } from "zod";
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import {
  WalletError,
  type AccountRef,
  type PreparedOperation,
  type TransactionIntent,
} from "@ewallet/domain";
import {
  fromBase64,
  toBase64,
  sha256,
  type SolanaAdapter,
  type SolanaPayload,
} from "./index";
const raw = z.string().regex(/^(0|[1-9][0-9]*)$/);
const SYSTEM = "11111111111111111111111111111111",
  COMPUTE = "ComputeBudget111111111111111111111111111111",
  MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export function decodeExternalSolana(transaction: string, account: AccountRef) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      transaction,
    )
  )
    throw new WalletError("ENCODING", "Use a canonical base64 transaction.");
  const tx = getTransactionDecoder().decode(fromBase64(transaction)),
    m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (
    toBase64(getTransactionEncoder().encode(tx)) !== transaction ||
    (m.version !== 0 && m.version !== "legacy") ||
    m.header.numSignerAccounts !== 1 ||
    m.header.numReadonlySignerAccounts !== 0 ||
    m.staticAccounts[0] !== account.address ||
    new Set(m.staticAccounts).size !== m.staticAccounts.length ||
    ("addressTableLookups" in m && m.addressTableLookups?.length) ||
    Object.values(tx.signatures).some((s) => s !== null)
  )
    throw new WalletError(
      "UNSUPPORTED_MESSAGE",
      "Only unsigned, single-payer legacy/v0 messages without lookup tables are supported.",
    );
  let recipient = "",
    amount = 0n,
    transfers = 0,
    limit = false,
    price = false;
  const details: string[] = [],
    used = new Set<number>([0]);
  const writable = (i: number) =>
    i >= 0 &&
    i < m.staticAccounts.length - m.header.numReadonlyNonSignerAccounts;
  if (m.instructions.length > 5)
    throw new WalletError(
      "UNSUPPORTED_MESSAGE",
      "Too many instructions for a simple transfer.",
    );
  for (const ix of m.instructions) {
    const program = m.staticAccounts[ix.programAddressIndex],
      data = new Uint8Array(ix.data ?? []),
      indices = Array.from(ix.accountIndices ?? []);
    used.add(ix.programAddressIndex);
    indices.forEach((i) => used.add(i));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (
      program === SYSTEM &&
      data.length === 12 &&
      view.getUint32(0, true) === 2 &&
      indices.length === 2 &&
      indices[0] === 0 &&
      indices[1] !== 0 &&
      writable(indices[1])
    ) {
      if (++transfers > 1)
        throw new WalletError(
          "UNSUPPORTED_MESSAGE",
          "Only one System transfer per approval is supported.",
        );
      recipient = m.staticAccounts[indices[1]];
      amount = view.getBigUint64(4, true);
      details.push(
        `Transfer ${amount} lamports from ${account.address} to ${recipient}.`,
      );
    } else if (
      program === COMPUTE &&
      indices.length === 0 &&
      data.length === 5 &&
      data[0] === 2 &&
      !limit
    ) {
      limit = true;
      const units = view.getUint32(1, true);
      if (units < 1 || units > 200000)
        throw new WalletError(
          "FEE_POLICY",
          "Compute limit exceeds the 200,000-unit transfer policy.",
        );
      details.push(`Compute unit limit ${units}.`);
    } else if (
      program === COMPUTE &&
      indices.length === 0 &&
      data.length === 9 &&
      data[0] === 3 &&
      !price
    ) {
      price = true;
      const micro = view.getBigUint64(1, true);
      if (micro > 100000n)
        throw new WalletError(
          "FEE_POLICY",
          "Compute-unit price exceeds 100,000 micro-lamports.",
        );
      details.push(`Compute unit price ${micro} micro-lamports.`);
    } else if (program === MEMO && indices.length === 0 && data.length <= 128) {
      const memo = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (
        Array.from(memo).some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        )
      )
        throw new WalletError(
          "UNSUPPORTED_MESSAGE",
          "Memo contains control characters.",
        );
      details.push(`Memo: ${memo}`);
    } else
      throw new WalletError(
        "UNSUPPORTED_MESSAGE",
        "Unknown instruction, durable nonce, extra signer or unsupported token operation. Only fully decoded System transfers and bounded compute/memo instructions are supported.",
      );
  }
  if (
    transfers !== 1 ||
    amount === 0n ||
    used.size !== m.staticAccounts.length ||
    Array.from(used).some((i) => i >= m.staticAccounts.length)
  )
    throw new WalletError(
      "UNSUPPORTED_MESSAGE",
      "A positive transfer and exactly its used accounts are required.",
    );
  return { tx, message: m, recipient, amount, details };
}
export async function prepareExternalSolana(
  adapter: SolanaAdapter,
  transaction: string,
  account: AccountRef,
  origin: string,
  requestId: string,
): Promise<PreparedOperation> {
  const decoded = decodeExternalSolana(transaction, account),
    genesisHash = await adapter.identity(),
    valid = z
      .object({ context: z.object({ slot: raw }), value: z.boolean() })
      .parse(
        await adapter.rpc("isBlockhashValid", [
          decoded.message.lifetimeToken,
          { commitment: "confirmed" },
        ]),
      );
  if (!valid.value)
    throw new WalletError(
      "BLOCKHASH_EXPIRED",
      "The supplied blockhash has expired. The dapp must prepare a fresh transaction; the wallet will not replace its message.",
    );
  const fee = z
    .object({ value: raw.nullable() })
    .parse(
      await adapter.rpc("getFeeForMessage", [
        toBase64(decoded.tx.messageBytes),
        { commitment: "confirmed" },
      ]),
    ).value;
  if (fee === null || BigInt(fee) > 1000000n)
    throw new WalletError(
      "FEE_POLICY",
      "The supplied blockhash or transaction fee is unavailable or outside policy.",
    );
  const balance = z
    .object({ value: raw })
    .parse(
      await adapter.rpc("getBalance", [
        account.address,
        { commitment: "confirmed" },
      ]),
    );
  if (BigInt(balance.value) < decoded.amount + BigInt(fee))
    throw new WalletError(
      "INSUFFICIENT_FUNDS",
      "Keep enough SOL for the transfer and fee.",
    );
  const simulation = z
    .object({ value: z.object({ err: z.unknown().nullable() }) })
    .parse(
      await adapter.rpc("simulateTransaction", [
        transaction,
        {
          encoding: "base64",
          commitment: "confirmed",
          sigVerify: false,
          replaceRecentBlockhash: false,
        },
      ]),
    );
  if (simulation.value.err !== null)
    throw new WalletError(
      "SIMULATION_FAILED",
      "The exact dapp transaction failed simulation.",
    );
  const height = raw.parse(
      await adapter.rpc("getBlockHeight", [{ commitment: "confirmed" }]),
    ),
    intent: TransactionIntent = {
      requestId,
      origin,
      accountId: account.id,
      networkId: adapter.networkId,
      kind: "send",
      recipient: decoded.recipient,
      asset: {
        networkId: adapter.networkId,
        standard: "native",
        reference: "native",
      },
      amount: String(decoded.amount),
    },
    now = Date.now(),
    expiresAt = now + 30000,
    payload: SolanaPayload = {
      family: "solana",
      genesisHash,
      unsignedTransaction: transaction,
      accountAddress: account.address,
      blockhash: decoded.message.lifetimeToken,
      lastValidBlockHeight: String(BigInt(height) + 150n),
      observedSlot: valid.context.slot,
      rent: "0",
      external: true,
    };
  return {
    id: crypto.randomUUID(),
    intent,
    encodedPayload: JSON.stringify(payload),
    preview: {
      sender: account.address,
      title: "Dapp SOL transfer",
      recipient: intent.recipient,
      amount: intent.amount,
      assetSymbol: "SOL",
      decimals: 9,
      decodedOperation: decoded.details.join(" "),
      warnings: [
        "The exact supplied message and blockhash will be signed. No lookup tables, nonce accounts or additional signers are accepted.",
      ],
    },
    fee: { estimated: fee, maximum: fee, symbol: "SOL", decimals: 9 },
    createdAt: now,
    expiresAt,
    fingerprint: `${adapter.networkId}:${account.address}:${payload.blockhash}`,
    digest: await sha256(JSON.stringify({ intent, payload, expiresAt })),
    source: "node",
  };
}
