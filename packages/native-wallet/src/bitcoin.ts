import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction, p2tr, p2wpkh, TEST_NETWORK } from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import type {
  AssetBalance,
  PreparedOperation,
  TransactionIntent,
} from "@ewallet/domain";
import type { NativeSecret, EntropySource } from "./vault";
import { nativeWords, nativePrivate, type MobileAccount } from "./keys";
import type { NativeApi } from "./api";
const net = { ...TEST_NETWORK, bech32: "bcrt" };
const genesis =
  "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206";
const versions = { private: 0x04358394, public: 0x043587cf };
type Watch = {
  purpose: 84 | 86;
  accountIndex: number;
  rootFingerprint: string;
  xpub: string;
};
const utxoSchema = z.object({
  txid: z.string().regex(/^[a-f0-9]{64}$/),
  vout: z.number().int().min(0),
  value: z.string().regex(/^[0-9]+$/),
  confirmations: z.string(),
  address: z.string(),
  scriptHex: z.string(),
  change: z.union([z.literal(0), z.literal(1)]),
  addressIndex: z.number().int().min(0).max(999),
  rawTransaction: z.string(),
});
const snapshotSchema = z.object({
  genesisHash: z.literal(genesis),
  ledgerFingerprint: z.string(),
  height: z.string(),
  blockHash: z.string(),
  feeRate: z.string().regex(/^[1-9][0-9]*$/),
  utxos: z.array(utxoSchema).max(5000),
});
const payloadSchema = z.object({
  family: z.literal("bitcoin"),
  watch: z.object({
    purpose: z.union([z.literal(84), z.literal(86)]),
    accountIndex: z.number().int(),
    rootFingerprint: z.string(),
    xpub: z.string(),
  }),
  watchId: z.string(),
  ledgerFingerprint: z.string(),
  psbt: z.string(),
  inputs: z.array(utxoSchema).min(1).max(10),
  fee: z.string(),
});
export function nativeBitcoinWatch(
  secret: NativeSecret,
  account: MobileAccount,
): Watch {
  const seed = mnemonicToSeedSync(
      nativeWords(secret).join(" "),
      secret.passphrase,
    ),
    root = HDKey.fromMasterSeed(seed, versions);
  try {
    const purpose = account.bitcoinType === "p2tr" ? 86 : 84,
      child = root.derive(`m/${purpose}'/1'/${account.index}'`);
    try {
      return {
        purpose,
        accountIndex: account.index,
        rootFingerprint: root.fingerprint.toString(16).padStart(8, "0"),
        xpub: child.publicExtendedKey,
      };
    } finally {
      child.wipePrivateData();
    }
  } finally {
    seed.fill(0);
    root.wipePrivateData();
  }
}
function derive(watch: Watch, change: 0 | 1, index: number) {
  if (index < 0 || index > 999)
    throw new Error("Address outside the imported range.");
  const root = HDKey.fromExtendedKey(watch.xpub, versions);
  if (root.privateKey) throw new Error("Public watch required.");
  const publicKey = root.deriveChild(change).deriveChild(index).publicKey!;
  return watch.purpose === 86
    ? p2tr(publicKey.slice(1), undefined, net)
    : p2wpkh(publicKey, net);
}
export class NativeBitcoin {
  private watchId: string | null = null;
  private historyWatchId: string | null = null;
  constructor(
    private api: NativeApi,
    readonly watch: Watch,
  ) {}
  async connect() {
    const result = await this.api.request<{
      watchId: string;
      historyWatchId: string;
      genesisHash: string;
    }>("/api/v1/bitcoin/watch", "POST", {
      acknowledged: true,
      watch: this.watch,
    });
    if (result.genesisHash !== genesis)
      throw new Error("Wrong Bitcoin network.");
    this.watchId = result.watchId;
    this.historyWatchId = result.historyWatchId;
  }
  async snapshot() {
    if (!this.watchId)
      throw new Error("Enable Bitcoin public watch discovery first.");
    return snapshotSchema.parse(
      await this.api.request("/api/v1/bitcoin/utxos", "POST", {
        watchId: this.watchId,
      }),
    );
  }
  async portfolio(): Promise<AssetBalance[]> {
    const snapshot = await this.snapshot(),
      total = snapshot.utxos.reduce((v, u) => v + BigInt(u.value), 0n),
      confirmed = snapshot.utxos
        .filter((u) => BigInt(u.confirmations) >= 6n)
        .reduce((v, u) => v + BigInt(u.value), 0n);
    return [
      {
        asset: {
          networkId: "bitcoin:regtest",
          standard: "native",
          reference: "native",
        },
        name: "Bitcoin",
        symbol: "BTC",
        decimals: 8,
        raw: String(total),
        available: String(confirmed),
        reserved: "0",
        microUsdRate: null,
        verified: true,
        hidden: false,
        stale: false,
        observation: {
          source: "node",
          networkId: "bitcoin:regtest",
          observedAt: new Date().toISOString(),
          observedHeight: snapshot.height,
          blockHash: snapshot.blockHash,
        },
      },
    ];
  }
  async prepare(
    intent: TransactionIntent,
    account: MobileAccount,
  ): Promise<PreparedOperation> {
    const snapshot = await this.snapshot(),
      amount = BigInt(intent.amount);
    if (
      intent.kind !== "send" ||
      intent.asset.standard !== "native" ||
      amount < 330n
    )
      throw new Error(
        "Bitcoin requires a native payment above its dust limit.",
      );
    const candidates = snapshot.utxos.filter(
        (u) => BigInt(u.confirmations) >= 6n,
      ),
      inputs: typeof candidates = [];
    let total = 0n,
      fee = 0n;
    const rate = BigInt(snapshot.feeRate);
    if (rate > 100n)
      throw new Error("Fee estimate exceeds the supported regtest limit.");
    for (const u of candidates) {
      inputs.push(u);
      total += BigInt(u.value);
      fee =
        BigInt(
          12 + inputs.length * (this.watch.purpose === 86 ? 59 : 69) + 86,
        ) * rate;
      if (total >= amount + fee || inputs.length === 10) break;
    }
    if (total < amount + fee)
      throw new Error("Not enough confirmed bitcoin for this payment and fee.");
    const change = await this.api.request<{
        addressIndex: number;
        change: 1;
        scriptHex: string;
        address: string;
      }>("/api/v1/bitcoin/address", "POST", {
        watchId: this.watchId,
        change: 1,
        minimumIndex: 0,
      }),
      changePayment = derive(this.watch, 1, change.addressIndex);
    if (
      changePayment.address !== change.address ||
      bytesToHex(changePayment.script) !== change.scriptHex
    )
      throw new Error("Change derivation mismatch.");
    const tx = new Transaction({ version: 2, lockTime: 0 });
    for (const input of inputs) {
      const owned = derive(this.watch, input.change, input.addressIndex),
        previous = Transaction.fromRaw(hexToBytes(input.rawTransaction)),
        out = previous.getOutput(input.vout);
      if (
        previous.id !== input.txid ||
        out.amount !== BigInt(input.value) ||
        bytesToHex(out.script!) !== input.scriptHex ||
        bytesToHex(owned.script) !== input.scriptHex
      )
        throw new Error("Input ownership or previous output mismatch.");
      tx.addInput({
        txid: input.txid,
        index: input.vout,
        sequence: 0xfffffffd,
        nonWitnessUtxo: hexToBytes(input.rawTransaction),
        witnessUtxo: { amount: BigInt(input.value), script: owned.script },
        ...(this.watch.purpose === 86
          ? {
              tapInternalKey:
                "tapInternalKey" in owned ? owned.tapInternalKey : undefined,
            }
          : {}),
      });
    }
    tx.addOutputAddress(intent.recipient, amount, net);
    const remainder = total - amount - fee;
    if (remainder >= 330n) tx.addOutputAddress(change.address, remainder, net);
    else fee += remainder;
    if (fee > 100000n) throw new Error("Fee is above the supported bound.");
    const payload = {
        family: "bitcoin" as const,
        watch: this.watch,
        watchId: this.watchId!,
        ledgerFingerprint: snapshot.ledgerFingerprint,
        psbt: base64.encode(tx.toPSBT()),
        inputs,
        fee: String(fee),
      },
      now = Date.now(),
      expiresAt = now + 60000,
      digest = bytesToHex(
        sha256(
          new TextEncoder().encode(
            JSON.stringify({ intent, payload, expiresAt }),
          ),
        ),
      );
    return {
      id: crypto.randomUUID(),
      intent,
      fingerprint: snapshot.ledgerFingerprint,
      source: "node",
      encodedPayload: JSON.stringify(payload),
      createdAt: now,
      expiresAt,
      digest,
      preview: {
        sender: account.address,
        recipient: intent.recipient,
        amount: intent.amount,
        assetSymbol: "BTC",
        decimals: 8,
        title: "send",
        decodedOperation: "Bitcoin payment with independently derived change",
        warnings: [
          "Spends confirmed outputs only. " +
            inputs.length +
            " inputs; estimated " +
            rate +
            " sat/vB.",
        ],
      },
      fee: {
        estimated: String(fee),
        maximum: String(fee),
        symbol: "BTC",
        decimals: 8,
      },
    };
  }
  async sign(
    operation: PreparedOperation,
    secret: NativeSecret,
    account: MobileAccount,
    random: EntropySource,
    guard: () => void = () => {},
  ) {
    const payload = payloadSchema.parse(JSON.parse(operation.encodedPayload)),
      digest = bytesToHex(
        sha256(
          new TextEncoder().encode(
            JSON.stringify({
              intent: operation.intent,
              payload,
              expiresAt: operation.expiresAt,
            }),
          ),
        ),
      );
    if (
      digest !== operation.digest ||
      Date.now() > operation.expiresAt ||
      JSON.stringify(payload.watch) !== JSON.stringify(this.watch)
    )
      throw new Error("Bitcoin review changed or expired.");
    const snapshot = await this.snapshot();
    guard();
    if (snapshot.ledgerFingerprint !== payload.ledgerFingerprint)
      throw new Error("Bitcoin ledger changed. Review again.");
    const tx = Transaction.fromPSBT(base64.decode(payload.psbt));
    if (tx.inputsLength !== payload.inputs.length)
      throw new Error("Input count changed.");
    for (const [index, input] of payload.inputs.entries()) {
      const current = snapshot.utxos.find(
        (u) => u.txid === input.txid && u.vout === input.vout,
      );
      if (
        !current ||
        current.value !== input.value ||
        current.scriptHex !== input.scriptHex ||
        BigInt(current.confirmations) < 6n
      )
        throw new Error("An input changed after review.");
      guard();
      const key = nativePrivate(
        secret,
        account,
        input.change,
        input.addressIndex,
      );
      try {
        tx.signIdx(key, index, undefined, random(32));
      } finally {
        key.fill(0);
      }
    }
    tx.finalize();
    if (tx.fee !== BigInt(payload.fee))
      throw new Error("Signed transaction fee differs from review.");
    const signed = tx.hex,
      accepted = await this.api.rpc<Array<{ allowed: boolean }>>(
        "bitcoin:regtest",
        "testmempoolaccept",
        [[signed]],
      );
    if (!accepted[0]?.allowed)
      throw new Error("Bitcoin Core rejected this transaction.");
    return { signed, hash: tx.id };
  }
  broadcast(signed: string) {
    return this.api.rpc<string>("bitcoin:regtest", "sendrawtransaction", [
      signed,
    ]);
  }
  async status(hash: string) {
    const result = await this.api.rpc<{
      confirmations?: string;
      blockhash?: string;
    }>("bitcoin:regtest", "getrawtransaction", [hash, true]);
    return {
      state:
        BigInt(result.confirmations ?? "0") >= 6n
          ? ("confirmed" as const)
          : BigInt(result.confirmations ?? "0") > 0n
            ? ("included" as const)
            : ("submitted" as const),
      height: null,
      fee: null,
      reorg: false,
    };
  }
  get historyId() {
    return this.historyWatchId;
  }
}
