export { prepareExternalBitcoin } from "./external";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import BIP32Factory from "bip32";
import { z } from "zod";
import { WalletError, parseAmount } from "@ewallet/domain";
bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const publicNodes = new Map<string, ReturnType<typeof bip32.fromBase58>>();
function publicNode(xpub: string) {
  let node = publicNodes.get(xpub);
  if (!node) {
    node = bip32.fromBase58(xpub, bitcoin.networks.regtest);
    if (!node.isNeutered())
      throw new WalletError(
        "DESCRIPTOR",
        "Private extended keys are rejected.",
      );
    if (publicNodes.size >= 40)
      publicNodes.delete(publicNodes.keys().next().value!);
    publicNodes.set(xpub, node);
  }
  return node;
}

export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function unhex(value: string) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value))
    throw new WalletError("ENCODING", "Invalid hexadecimal encoding.");
  return Uint8Array.from(value.match(/../g)!, (b) => parseInt(b, 16));
}

export const REGTEST_GENESIS =
  "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206";
export const bitcoinWatchSchema = z
  .object({
    purpose: z.union([z.literal(84), z.literal(86)]),
    accountIndex: z.number().int().min(0).max(999),
    rootFingerprint: z.string().regex(/^[0-9a-f]{8}$/),
    xpub: z.string().regex(/^tpub[1-9A-HJ-NP-Za-km-z]{100,120}$/),
  })
  .strict();
export type BitcoinWatch = z.infer<typeof bitcoinWatchSchema>;
export function validateWatch(input: unknown) {
  const watch = bitcoinWatchSchema.parse(input),
    node = publicNode(watch.xpub);
  if (
    !node.isNeutered() ||
    node.depth !== 3 ||
    node.index !== 0x80000000 + watch.accountIndex
  )
    throw new WalletError(
      "DESCRIPTOR",
      "Expected a public account key at the reviewed BIP84 or BIP86 path.",
    );
  return watch;
}
export function publicDescriptor(input: BitcoinWatch, change: 0 | 1) {
  const watch = validateWatch(input);
  return `${watch.purpose === 84 ? "wpkh" : "tr"}([${watch.rootFingerprint}/${watch.purpose}h/1h/${watch.accountIndex}h]${watch.xpub}/${change}/*)`;
}
export function deriveWatchAddress(
  input: BitcoinWatch,
  change: 0 | 1,
  index: number,
) {
  const watch = validateWatch(input);
  if (!Number.isSafeInteger(index) || index < 0 || index > 10000)
    throw new WalletError(
      "DERIVATION",
      "Address index is outside the supported range.",
    );
  const node = bip32
      .fromBase58(watch.xpub, bitcoin.networks.regtest)
      .derive(change)
      .derive(index),
    payment =
      watch.purpose === 84
        ? bitcoin.payments.p2wpkh({
            pubkey: node.publicKey,
            network: bitcoin.networks.regtest,
          })
        : bitcoin.payments.p2tr({
            internalPubkey: node.publicKey.slice(1),
            network: bitcoin.networks.regtest,
          });
  if (!payment.address || !payment.output)
    throw new WalletError("DERIVATION", "Unable to derive a regtest output.");
  return {
    address: payment.address,
    scriptHex: hex(payment.output),
    path: `m/${watch.purpose}'/1'/${watch.accountIndex}'/${change}/${index}`,
    change,
    addressIndex: index,
    publicKey: hex(node.publicKey),
  };
}
export function validateRegtestAddress(address: string) {
  try {
    const script = bitcoin.address.toOutputScript(
      address,
      bitcoin.networks.regtest,
    );
    if (
      !(script.length === 22 && script[0] === 0 && script[1] === 20) &&
      !(script.length === 34 && script[0] === 0x51 && script[1] === 32)
    )
      throw new Error("script");
    return {
      scriptHex: hex(script),
      dust: script.length === 22 ? 294n : 330n,
      outputBytes: script.length + 9,
    };
  } catch {
    throw new WalletError(
      "RECIPIENT",
      "Use a complete P2WPKH or P2TR Bitcoin regtest address (bcrt1).",
    );
  }
}
export const utxoSchema = z
  .object({
    txid: z.string().regex(/^[a-f0-9]{64}$/),
    vout: z.number().int().min(0).max(100000),
    value: z.string().regex(/^[1-9][0-9]*$/),
    scriptHex: z.string().regex(/^[a-f0-9]+$/),
    confirmations: z.string().regex(/^[0-9]+$/),
    path: z.string(),
    change: z.union([z.literal(0), z.literal(1)]),
    addressIndex: z.number().int().min(0).max(10000),
    address: z.string(),
    rawTransaction: z
      .string()
      .regex(/^[a-f0-9]+$/)
      .max(800000),
  })
  .strict();
export type BitcoinUtxo = z.infer<typeof utxoSchema>;
export function verifiedUtxo(utxo: BitcoinUtxo, watch: BitcoinWatch) {
  const derived = deriveWatchAddress(watch, utxo.change, utxo.addressIndex),
    tx = bitcoin.Transaction.fromHex(utxo.rawTransaction),
    output = tx.outs[utxo.vout];
  if (
    tx.getId() !== utxo.txid ||
    !output ||
    output.value !== BigInt(utxo.value) ||
    hex(output.script) !== utxo.scriptHex ||
    derived.scriptHex !== utxo.scriptHex ||
    derived.path !== utxo.path ||
    derived.address !== utxo.address
  )
    throw new WalletError(
      "UTXO_MISMATCH",
      "Referenced output, amount, script or derivation differs from the node data.",
    );
  return derived;
}
export function satoshis(value: string) {
  return parseAmount(value, 8).toString();
}
export function selectCoins(
  utxos: BitcoinUtxo[],
  amount: bigint,
  recipient: string,
  changeAddress: string,
  purpose: 84 | 86,
  feeRate: bigint,
) {
  const destination = validateRegtestAddress(recipient),
    change = validateRegtestAddress(changeAddress);
  if (amount < destination.dust)
    throw new WalletError(
      "DUST",
      "Recipient amount is below this script’s dust threshold.",
    );
  if (feeRate < 1n || feeRate > 100n)
    throw new WalletError("FEE_POLICY", "Fee rate is outside 1–100 sat/vByte.");
  const inputVbytes = purpose === 84 ? 69n : 58n,
    estimate = (count: number, withChange: boolean) =>
      11n +
      BigInt(count) * inputVbytes +
      BigInt(destination.outputBytes) +
      (withChange ? BigInt(change.outputBytes) : 0n);
  const confirmed = utxos.filter((u) => BigInt(u.confirmations) > 0n),
    sorted = [...confirmed].sort((a, b) =>
      BigInt(a.value) === BigInt(b.value)
        ? `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`)
        : BigInt(a.value) > BigInt(b.value)
          ? -1
          : 1,
    );
  const single = [...sorted]
    .reverse()
    .find((u) => BigInt(u.value) >= amount + estimate(1, true) * feeRate);
  const chosen: BitcoinUtxo[] = single ? [single] : [];
  let total = single ? BigInt(single.value) : 0n;
  if (!single)
    for (const coin of sorted) {
      chosen.push(coin);
      total += BigInt(coin.value);
      if (total >= amount + estimate(chosen.length, true) * feeRate) break;
      if (chosen.length >= 10) break;
    }
  if (
    chosen.length === 0 ||
    chosen.length > 10 ||
    total < amount + estimate(chosen.length, false) * feeRate
  )
    throw new WalletError(
      "INSUFFICIENT_FUNDS",
      "Insufficient confirmed, unreserved outputs within the ten-input policy.",
    );
  let fee = estimate(chosen.length, true) * feeRate,
    changeValue = total - amount - fee,
    dustToFee = 0n;
  if (changeValue < change.dust) {
    fee = total - amount;
    dustToFee = fee - estimate(chosen.length, false) * feeRate;
    changeValue = 0n;
  }
  if (
    fee < 0n ||
    fee > 1000000n ||
    fee > estimate(chosen.length, changeValue > 0n) * 100n
  )
    throw new WalletError(
      "FEE_POLICY",
      "Fee exceeds the supported absolute or effective-rate bound.",
    );
  return {
    inputs: chosen,
    amount,
    fee,
    change: changeValue,
    dustToFee,
    estimatedVbytes: estimate(chosen.length, changeValue > 0n),
    feeRate,
  };
}
export function buildPsbt(
  watch: BitcoinWatch,
  selection: ReturnType<typeof selectCoins>,
  recipient: string,
  changeIndex: number,
) {
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.setVersion(2);
  for (const input of selection.inputs) {
    const derived = verifiedUtxo(input, watch);
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      sequence: 0xfffffffe,
      witnessUtxo: {
        script: unhex(input.scriptHex),
        value: BigInt(input.value),
      },
      ...(watch.purpose === 86
        ? {
            tapInternalKey: unhex(derived.publicKey).slice(1),
          }
        : { sighashType: bitcoin.Transaction.SIGHASH_ALL }),
    });
  }
  psbt.addOutput({ address: recipient, value: selection.amount });
  if (selection.change > 0n)
    psbt.addOutput({
      address: deriveWatchAddress(watch, 1, changeIndex).address,
      value: selection.change,
    });
  return psbt;
}
export { bitcoin, ecc };

export const bitcoinPayloadSchema = z
  .object({
    family: z.literal("bitcoin"),
    genesisHash: z.literal(REGTEST_GENESIS),
    ledgerFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    watch: bitcoinWatchSchema,
    watchId: z.string().regex(/^[a-f0-9]{64}$/),
    psbt: z.string().max(100000),
    inputs: z.array(utxoSchema).min(1).max(10),
    recipient: z.string(),
    amount: z.string().regex(/^[1-9][0-9]*$/),
    change: z.string().regex(/^[0-9]+$/),
    changeIndex: z.number().int().min(0).max(10000),
    fee: z.string().regex(/^[1-9][0-9]*$/),
    feeRate: z.string().regex(/^[0-9]+$/),
    estimatedVbytes: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export type BitcoinPayload = z.infer<typeof bitcoinPayloadSchema>;
export function validateReviewedPsbt(payload: BitcoinPayload) {
  const psbt = bitcoin.Psbt.fromBase64(payload.psbt, {
      network: bitcoin.networks.regtest,
    }),
    watch = validateWatch(payload.watch);
  if (
    psbt.version !== 2 ||
    psbt.locktime !== 0 ||
    psbt.inputCount !== payload.inputs.length ||
    psbt.txOutputs.length !== (BigInt(payload.change) > 0n ? 2 : 1) ||
    Object.keys(psbt.data.globalMap).some(
      (key) => !["unsignedTx", "unknownKeyVals"].includes(key),
    ) ||
    psbt.data.globalMap.unknownKeyVals?.length
  )
    throw new WalletError(
      "PSBT_POLICY",
      "Unexpected PSBT version, input count, outputs or global fields.",
    );
  let total = 0n;
  for (let i = 0; i < payload.inputs.length; i++) {
    const input = payload.inputs[i],
      derived = verifiedUtxo(input, watch),
      data = psbt.data.inputs[i],
      unsigned = psbt.txInputs[i];
    if (
      Object.keys(data).some(
        (key) =>
          ![
            "witnessUtxo",
            "sighashType",
            "tapInternalKey",
            "unknownKeyVals",
          ].includes(key),
      ) ||
      hex(new Uint8Array(unsigned.hash).reverse()) !== input.txid ||
      unsigned.index !== input.vout ||
      unsigned.sequence !== 0xfffffffe ||
      !data.witnessUtxo ||
      data.witnessUtxo.value !== BigInt(input.value) ||
      hex(data.witnessUtxo.script) !== derived.scriptHex ||
      data.nonWitnessUtxo ||
      data.partialSig ||
      data.tapKeySig ||
      data.tapScriptSig ||
      data.tapLeafScript ||
      data.redeemScript ||
      data.witnessScript ||
      data.finalScriptSig ||
      data.finalScriptWitness ||
      data.unknownKeyVals?.length ||
      data.tapMerkleRoot ||
      (watch.purpose === 86
        ? (data.sighashType ?? 0) !== bitcoin.Transaction.SIGHASH_DEFAULT
        : data.sighashType !== bitcoin.Transaction.SIGHASH_ALL) ||
      (watch.purpose === 86 &&
        (!data.tapInternalKey ||
          hex(data.tapInternalKey) !== derived.publicKey.slice(2)))
    )
      throw new WalletError(
        "PSBT_POLICY",
        "An input differs from the reviewed output or uses unsupported authorization fields.",
      );
    total += BigInt(input.value);
  }
  const recipient = validateRegtestAddress(payload.recipient);
  if (
    hex(psbt.txOutputs[0].script) !== recipient.scriptHex ||
    psbt.txOutputs[0].value !== BigInt(payload.amount)
  )
    throw new WalletError(
      "PSBT_OUTPUT",
      "Recipient output differs from the review.",
    );
  if (BigInt(payload.change) > 0n) {
    const change = deriveWatchAddress(watch, 1, payload.changeIndex);
    if (
      hex(psbt.txOutputs[1].script) !== change.scriptHex ||
      psbt.txOutputs[1].value !== BigInt(payload.change)
    )
      throw new WalletError(
        "PSBT_OUTPUT",
        "Change is not independently derived on the internal branch.",
      );
  }
  if (
    total - psbt.txOutputs.reduce((sum, o) => sum + o.value, 0n) !==
      BigInt(payload.fee) ||
    BigInt(payload.fee) > 1000000n ||
    BigInt(payload.feeRate) < 1n ||
    BigInt(payload.feeRate) > 100n
  )
    throw new WalletError(
      "PSBT_FEE",
      "Reviewed fee differs from input/output arithmetic or policy.",
    );
  for (const output of psbt.data.outputs)
    if (
      Object.keys(output).some((key) => !["unknownKeyVals"].includes(key)) ||
      output.unknownKeyVals?.length
    )
      throw new WalletError("PSBT_POLICY", "Unexpected output metadata.");
  return psbt;
}
export const bitcoinWatchStateSchema = z.object({
  watchId: z.string(),
  genesisHash: z.literal(REGTEST_GENESIS),
  ledgerFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  height: z.string().regex(/^[0-9]+$/),
  blockHash: z.string().regex(/^[0-9a-f]{64}$/),
  utxos: z.array(utxoSchema).max(500),
  discovery: z
    .array(
      z.object({
        change: z.union([z.literal(0), z.literal(1)]),
        lastUsed: z.number().int(),
        next: z.number().int(),
        gapLimit: z.literal(20),
      }),
    )
    .length(2),
  feeRate: z.string().regex(/^[0-9]+$/),
  feeSource: z.string(),
  observationId: z.string(),
});
export { BitcoinAdapter } from "./adapter";
export { bitcoinStatus } from "./adapter";
