import { nativeHistory } from "./history";
import { NativeBitcoin, nativeBitcoinWatch } from "./bitcoin";
import {
  JsonRpcProvider,
  Wallet,
  Transaction,
  keccak256,
  toUtf8Bytes,
  type JsonRpcPayload,
  type JsonRpcResult,
} from "ethers";
import { EvmAdapter, evmPayloadSchema } from "@ewallet/chain-evm";
import {
  SolanaAdapter,
  solanaPayloadSchema,
  fromBase64,
  toBase64,
} from "@ewallet/chain-solana";
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  type SignatureBytes,
} from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import { networkById } from "@ewallet/config";
import {
  type AccountRef,
  type AssetBalance,
  type Collectible,
  type PreparedOperation,
  type TransactionIntent,
  type TransactionRecord,
  transactionRecordSchema,
  transactionIntentSchema,
} from "@ewallet/domain";
import { NativeApi } from "./api";
import {
  nativeAccount,
  nativeCreate,
  nativeImport,
  nativePrivate,
  nativeWords,
  type MobileAccount,
} from "./keys";
import {
  decryptNativeSecret,
  encryptNativeSecret,
  validateNativePassword,
  type DeviceStore,
  type EntropySource,
  type NativeSecret,
  type NativeEnvelope,
} from "./vault";
export type NativeState = {
  initialized: boolean;
  locked: boolean;
  accounts: MobileAccount[];
  selectedAccountId: string;
  networkId: string;
  balances: AssetBalance[];
  collectibles: Collectible[];
  activity: TransactionRecord[];
  status: "idle" | "loading" | "ready" | "unavailable";
  updatedAt: string | null;
  history?: {
    watchId: string;
    nextCursor: string | null;
    status: string;
    coverage: string;
  };
};
type SignedEntry = {
  operation: PreparedOperation;
  hash: string;
  signed: string;
  record: TransactionRecord;
};
class NativeProvider extends JsonRpcProvider {
  constructor(
    private api: NativeApi,
    private networkId: string,
  ) {
    super(undefined, Number(networkId.split(":")[1]), {
      staticNetwork: true,
      batchMaxCount: 1,
      cacheTimeout: 0,
    });
  }
  override async _send(
    payload: JsonRpcPayload | JsonRpcPayload[],
  ): Promise<JsonRpcResult[]> {
    return Promise.all(
      (Array.isArray(payload) ? payload : [payload]).map((request) =>
        this.api.request<JsonRpcResult>(
          "/api/v1/rpc/" + encodeURIComponent(this.networkId),
          "POST",
          request,
        ),
      ),
    );
  }
}
export class NativeWallet {
  private secret: NativeSecret | null = null;
  private envelope: NativeEnvelope | null = null;
  private generation = 0;
  private pendingSetup: {
    secret: NativeSecret;
    envelope: NativeEnvelope;
    challenge: number[];
  } | null = null;
  private pending: PreparedOperation | null = null;
  private signing = false;
  private failures = 0;
  private retryAt = 0;
  private listeners = new Set<() => void>();
  private journal: SignedEntry[] = [];
  private lastTouch = Date.now();
  private bitcoinWatches = new Map<string, NativeBitcoin>();
  private state: NativeState = {
    initialized: false,
    locked: true,
    accounts: [],
    selectedAccountId: "",
    networkId: "eip155:11155111",
    balances: [],
    collectibles: [],
    activity: [],
    status: "idle",
    updatedAt: null,
  };
  constructor(
    private store: DeviceStore,
    private random: EntropySource,
    readonly api: NativeApi,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(patch: Partial<NativeState> = {}) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private assert(generation = this.generation) {
    if (!this.secret || this.state.locked || generation !== this.generation)
      throw new Error("Wallet locked. Unlock and review again.");
    if (Date.now() - this.lastTouch > 300000) {
      this.lock();
      throw new Error("Wallet locked after inactivity.");
    }
  }
  private get slot() {
    return "vault.testnet.v1";
  }
  async open() {
    const raw = await this.store.get(this.slot);
    this.emit({ initialized: raw !== null });
  }
  touch() {
    this.lastTouch = Date.now();
  }
  tick() {
    if (!this.state.locked && Date.now() - this.lastTouch > 300000) this.lock();
  }
  lock() {
    this.generation++;
    this.secret = null;
    this.pendingSetup = null;
    this.pending = null;
    this.api.clear();
    this.bitcoinWatches.clear();
    this.emit({ locked: true });
  }
  async create(password: string, confirmation: string) {
    if (this.state.initialized) throw new Error("A wallet already exists.");
    validateNativePassword(password, confirmation);
    const g = ++this.generation,
      secret = nativeCreate(this.random),
      envelope = await encryptNativeSecret(secret, password, this.random);
    if (g !== this.generation)
      throw new Error("Creation cancelled. Start again.");
    const challenge = Array.from(
      new Set(Array.from(this.random(24), (n) => n % 24)),
    ).slice(0, 3);
    if (challenge.length !== 3)
      throw new Error("Unable to generate a backup challenge. Retry.");
    this.pendingSetup = { secret, envelope, challenge };
    return { words: nativeWords(secret), challenge };
  }
  async finishBackup(answers: string[]) {
    const pending = this.pendingSetup;
    if (!pending || answers.length !== 3)
      throw new Error("Start wallet creation again.");
    const words = nativeWords(pending.secret);
    if (
      pending.challenge.some(
        (n, i) => words[n] !== answers[i]?.trim().toLowerCase(),
      )
    )
      throw new Error("The recovery words do not match.");
    await this.commit(pending.secret, pending.envelope);
    this.pendingSetup = null;
  }
  async restore(
    words: string,
    password: string,
    confirmation: string,
    passphrase = "",
  ) {
    if (this.state.initialized) throw new Error("A wallet already exists.");
    validateNativePassword(password, confirmation);
    const g = ++this.generation,
      secret = nativeImport(words, passphrase),
      envelope = await encryptNativeSecret(secret, password, this.random);
    if (g !== this.generation) throw new Error("Restore cancelled.");
    await this.commit(secret, envelope);
  }
  private async commit(secret: NativeSecret, envelope: NativeEnvelope) {
    const g = this.generation;
    await this.store.set(this.slot, JSON.stringify(envelope));
    if (g !== this.generation) {
      this.emit({ initialized: true });
      throw new Error("Wallet saved and locked. Unlock to continue.");
    }
    this.secret = secret;
    this.envelope = envelope;
    await this.load();
  }
  async unlock(password: string) {
    if (Date.now() < this.retryAt)
      throw new Error("Wait before trying another password.");
    const g = ++this.generation,
      raw = await this.store.get(this.slot);
    if (!raw) throw new Error("Restore your recovery phrase to open a wallet.");
    try {
      const decoded = await decryptNativeSecret(raw, password);
      if (g !== this.generation) throw new Error("Unlock cancelled.");
      this.secret = decoded.secret;
      this.envelope = decoded.envelope;
      this.failures = 0;
      await this.load();
    } catch (error) {
      this.failures++;
      this.retryAt =
        Date.now() + Math.min(30000, 500 * 2 ** Math.min(this.failures, 6));
      throw error;
    }
  }
  private async load() {
    this.lastTouch = Date.now();
    const secret = this.secret!;
    const publicRaw = await this.store.get("public.testnet.v1");
    let indexes: number[] = [0];
    if (publicRaw) {
      const data = JSON.parse(publicRaw);
      if (Array.isArray(data.indexes))
        indexes = data.indexes
          .filter(
            (n: unknown) =>
              Number.isInteger(n) && Number(n) >= 0 && Number(n) < 1000,
          )
          .slice(0, 20);
    }
    const accounts = indexes.flatMap((index) => [
      nativeAccount(secret, "evm", index),
      nativeAccount(secret, "solana", index),
      nativeAccount(secret, "bitcoin", index),
      nativeAccount(secret, "bitcoin", index, "p2tr"),
    ]);
    const journal = await this.store.get("journal.testnet.v1");
    this.journal = journal ? JSON.parse(journal) : [];
    this.emit({
      initialized: true,
      locked: false,
      accounts,
      selectedAccountId: accounts.find(
        (a) => a.family === networkById(this.state.networkId).family,
      )!.id,
      activity: this.journal.map((e) =>
        transactionRecordSchema.parse(e.record),
      ),
    });
  }
  async addAccount() {
    this.assert();
    const index = Math.max(...this.state.accounts.map((a) => a.index)) + 1;
    if (index >= 20) throw new Error("This release supports twenty accounts.");
    const indexes = Array.from(
      new Set(this.state.accounts.map((a) => a.index)),
    ).concat(index);
    await this.store.set("public.testnet.v1", JSON.stringify({ indexes }));
    this.assert();
    this.emit({
      accounts: this.state.accounts.concat(
        ["evm", "solana", "bitcoin"].flatMap((f) => [
          nativeAccount(this.secret!, f as MobileAccount["family"], index),
        ]),
      ),
    });
  }
  selectNetwork(id: string) {
    this.assert();
    if (this.signing) throw new Error("Wait for signing to finish.");
    const profile = networkById(id);
    if (profile.environment !== "testnet" && profile.environment !== "local")
      throw new Error("This network is unavailable.");
    const account = this.state.accounts.find(
      (a) => a.family === profile.family,
    );
    if (!account) throw new Error("No account for this network.");
    this.pending = null;
    this.emit({
      networkId: id,
      selectedAccountId: account.id,
      history: undefined,
      balances: [],
      collectibles: [],
      status: "idle",
    });
  }
  selectAccount(id: string) {
    this.assert();
    if (this.signing) throw new Error("Wait for signing to finish.");
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account || account.family !== networkById(this.state.networkId).family)
      throw new Error("Select an account for this network.");
    this.pending = null;
    this.emit({
      selectedAccountId: id,
      balances: [],
      collectibles: [],
      status: "idle",
    });
  }
  private account(): AccountRef {
    const a = this.state.accounts.find(
      (a) => a.id === this.state.selectedAccountId,
    );
    if (!a || !this.envelope) throw new Error("Choose an account.");
    return { ...a, rootWalletId: this.envelope.id };
  }
  private fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    const response = await this.api.fetch(path, init);
    return response;
  };
  private adapter() {
    const profile = networkById(this.state.networkId);
    if (profile.family === "bitcoin") {
      const watch = this.bitcoinWatches.get(this.state.selectedAccountId);
      if (!watch)
        throw new Error("Enable Bitcoin public watch discovery first.");
      return watch;
    }
    if (profile.family === "evm")
      return new EvmAdapter(
        profile.id,
        new NativeProvider(this.api, profile.id),
        this.fetcher,
      );
    return new SolanaAdapter(
      profile.id,
      (method, params = []) => this.api.rpc(profile.id, method, params),
      undefined,
      this.fetcher,
    );
  }
  async refresh() {
    this.assert();
    const g = this.generation,
      account = this.account(),
      network = this.state.networkId;
    this.emit({ status: "loading" });
    try {
      const adapter = this.adapter();
      let balances: AssetBalance[], collectibles: Collectible[];
      if (adapter instanceof EvmAdapter) {
        [balances, collectibles] = await Promise.all([
          adapter.balances(account),
          adapter.collectibles(account),
        ]);
      } else if (adapter instanceof NativeBitcoin) {
        balances = await adapter.portfolio();
        collectibles = [];
      } else {
        const result = await adapter.portfolio(account);
        balances = result.balances;
        collectibles = result.collectibles;
      }
      this.assert(g);
      if (
        this.state.networkId !== network ||
        this.state.selectedAccountId !== account.id
      )
        return;
      for (const entry of this.journal.filter(
        (e) =>
          e.record.networkId === network &&
          e.operation.intent.accountId === account.id,
      )) {
        try {
          const status =
            adapter instanceof EvmAdapter
              ? await adapter.status(entry.hash)
              : adapter instanceof NativeBitcoin
                ? await adapter.status(entry.hash)
                : await adapter.status(
                    entry.hash,
                    solanaPayloadSchema.parse(
                      JSON.parse(entry.operation.encodedPayload),
                    ).lastValidBlockHeight,
                  );
          entry.record = { ...entry.record, ...status };
        } catch {
          /* Keep last verified public receipt and retry on refresh. */
        }
      }
      this.assert(g);
      await this.saveJournal();
      const localActivity = this.journal
        .filter(
          (e) =>
            e.record.intent.accountId === account.id &&
            e.record.networkId === network,
        )
        .map((e) => e.record);
      let activity = localActivity,
        history: NativeState["history"];
      try {
        const watch =
          adapter instanceof NativeBitcoin ? adapter.historyId : undefined;
        const result = await nativeHistory(
          this.api,
          account,
          network,
          localActivity,
          watch ?? undefined,
        );
        activity = result.activity;
        history = result.history;
      } catch {
        history = {
          watchId: "",
          nextCursor: null,
          status: "unavailable",
          coverage:
            "Indexed history is unavailable; local transaction journal remains visible.",
        };
      }
      this.assert(g);
      if (
        this.state.networkId !== network ||
        this.state.selectedAccountId !== account.id
      )
        return;
      this.emit({
        balances,
        collectibles,
        activity,
        history,
        status: "ready",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (g === this.generation) this.emit({ status: "unavailable" });
      throw error;
    }
  }
  async loadOlderActivity() {
    this.assert();
    const current = this.state.history;
    if (!current?.nextCursor || !current.watchId) return;
    if (this.state.activity.length >= 500)
      throw new Error("Showing the most recent 500 activity entries.");
    const g = this.generation,
      account = this.account(),
      network = this.state.networkId,
      result = await nativeHistory(
        this.api,
        account,
        network,
        [],
        current.watchId,
        current.nextCursor,
      );
    this.assert(g);
    if (
      this.state.networkId !== network ||
      this.state.selectedAccountId !== account.id
    )
      return;
    const ids = new Set(this.state.activity.map((t) => t.id));
    this.emit({
      activity: this.state.activity.concat(
        result.activity.filter((t) => !ids.has(t.id)),
      ),
      history: result.history,
    });
  }
  async prepare(intent: TransactionIntent) {
    this.assert();
    this.touch();
    if (
      this.signing ||
      this.journal.some(
        (e) =>
          e.record.intent.accountId === intent.accountId &&
          e.record.networkId === intent.networkId &&
          [
            "signed",
            "submitted",
            "submission_unknown",
            "included",
            "orphaned",
          ].includes(e.record.state),
      )
    )
      throw new Error(
        "Wait for the current transaction to settle before preparing another.",
      );
    const g = this.generation,
      parsed = transactionIntentSchema.parse(intent),
      account = this.account(),
      adapter = this.adapter();
    if (
      parsed.accountId !== account.id ||
      parsed.asset.networkId !== parsed.networkId ||
      parsed.networkId !== this.state.networkId
    )
      throw new Error("Account or network changed.");
    const operation =
      adapter instanceof EvmAdapter
        ? await adapter.prepare(
            parsed,
            account,
            await adapter.provider.getTransactionCount(
              account.address,
              "pending",
            ),
            (await adapter.environment()).bootEpoch,
          )
        : await adapter.prepare(parsed, account);
    this.assert(g);
    if (
      this.state.networkId !== parsed.networkId ||
      this.state.selectedAccountId !== account.id
    )
      throw new Error("Account changed. Review again.");
    this.pending = structuredClone(operation);
    return structuredClone(operation);
  }
  reject() {
    this.pending = null;
  }
  async approve(id: string, digest: string) {
    this.assert();
    this.touch();
    if (this.signing) throw new Error("An approval is already running.");
    const operation = this.pending;
    if (
      !operation ||
      operation.id !== id ||
      operation.digest !== digest ||
      Date.now() > operation.expiresAt
    )
      throw new Error("The approval expired or changed. Review again.");
    this.pending = null;
    this.signing = true;
    const g = this.generation,
      account = this.account(),
      adapter = this.adapter();
    let privateKey: Uint8Array | undefined;
    try {
      if (!(adapter instanceof NativeBitcoin))
        await adapter.revalidate(operation, account);
      this.assert(g);
      if (
        operation.intent.accountId !== account.id ||
        operation.intent.networkId !== this.state.networkId
      )
        throw new Error("Account or network changed.");
      if (!(adapter instanceof NativeBitcoin))
        privateKey = nativePrivate(this.secret!, account);
      let signed: string, hash: string;
      if (adapter instanceof NativeBitcoin) {
        const result = await adapter.sign(
          operation,
          this.secret!,
          account,
          this.random,
          () => this.assert(g),
        );
        signed = result.signed;
        hash = result.hash;
      } else if (adapter instanceof EvmAdapter) {
        const payload = evmPayloadSchema.parse(
          JSON.parse(operation.encodedPayload),
        );
        if (
          keccak256(
            toUtf8Bytes(
              JSON.stringify({
                intent: operation.intent,
                payload,
                expiresAt: operation.expiresAt,
              }),
            ),
          ).slice(2) !== operation.digest
        )
          throw new Error("Review digest changed.");
        const tx = Transaction.from(payload.unsignedTransaction);
        if (
          tx.signature ||
          tx.chainId !== BigInt(adapter.profile.identity) ||
          payload.accountAddress.toLowerCase() !== account.address.toLowerCase()
        )
          throw new Error("Signing identity differs from the review.");
        const signer = new Wallet("0x" + bytesToHex(privateKey!));
        if (signer.address.toLowerCase() !== account.address.toLowerCase())
          throw new Error("Account derivation mismatch.");
        signed = await signer.signTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          nonce: tx.nonce,
          chainId: tx.chainId,
          gasLimit: tx.gasLimit,
          type: tx.type,
          ...(tx.type === 2
            ? {
                maxFeePerGas: tx.maxFeePerGas,
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
              }
            : { gasPrice: tx.gasPrice }),
        });
        hash = keccak256(signed);
      } else {
        const payload = solanaPayloadSchema.parse(
            JSON.parse(operation.encodedPayload),
          ),
          tx = getTransactionDecoder().decode(
            fromBase64(payload.unsignedTransaction),
          ),
          message = getCompiledTransactionMessageDecoder().decode(
            tx.messageBytes,
          );
        if (
          payload.accountAddress !== account.address ||
          message.header.numSignerAccounts !== 1 ||
          message.staticAccounts[0] !== account.address ||
          message.lifetimeToken !== payload.blockhash ||
          Object.values(tx.signatures).some((s) => s !== null)
        )
          throw new Error("Unsupported message or signer.");
        const signature = ed25519.sign(
          new Uint8Array(tx.messageBytes),
          privateKey!,
        );
        if (
          base58.encode(ed25519.getPublicKey(privateKey!)) !== account.address
        )
          throw new Error("Account derivation mismatch.");
        signed = toBase64(
          getTransactionEncoder().encode({
            ...tx,
            signatures: {
              ...tx.signatures,
              [account.address]: signature as SignatureBytes,
            },
          }),
        );
        hash = base58.encode(signature);
      }
      this.assert(g);
      const record: TransactionRecord = {
          id,
          networkId: operation.intent.networkId,
          hash,
          intent: operation.intent,
          state: "signed",
          height: null,
          fee: null,
          createdAt: new Date().toISOString(),
          replacementId: null,
          reorg: false,
          source: "node",
          direction: "outgoing",
        },
        entry = { operation, hash, signed, record };
      this.journal.push(entry);
      await this.saveJournal();
      this.assert(g);
      try {
        const actual =
          adapter instanceof EvmAdapter
            ? await adapter.provider.send("eth_sendRawTransaction", [signed])
            : await adapter.broadcast(signed);
        if (actual !== hash) throw new Error("Broadcast identifier mismatch");
        record.state = "submitted";
      } catch {
        record.state = "submission_unknown";
      }
      await this.saveJournal();
      this.emit({
        activity: this.journal
          .filter((e) => e.record.networkId === this.state.networkId)
          .map((e) => e.record),
      });
      return structuredClone(record);
    } finally {
      privateKey?.fill(0);
      this.signing = false;
    }
  }
  async retrySubmission(id: string) {
    this.assert();
    if (this.signing) throw new Error("A submission is already running.");
    const entry = this.journal.find(
      (e) =>
        e.record.id === id &&
        e.record.networkId === this.state.networkId &&
        e.operation.intent.accountId === this.state.selectedAccountId,
    );
    if (
      !entry ||
      !["signed", "submitted", "submission_unknown", "orphaned"].includes(
        entry.record.state,
      )
    )
      throw new Error("No uncertain submission is available.");
    this.signing = true;
    const g = this.generation;
    try {
      const adapter = this.adapter();
      if (adapter instanceof EvmAdapter) {
        const payload = evmPayloadSchema.parse(
          JSON.parse(entry.operation.encodedPayload),
        );
        if ((await adapter.environment()).bootEpoch !== payload.bootEpoch)
          throw new Error(
            "The local chain restarted. This transaction cannot be replayed into another ledger.",
          );
      } else if (adapter instanceof SolanaAdapter) {
        const payload = solanaPayloadSchema.parse(
          JSON.parse(entry.operation.encodedPayload),
        );
        if ((await adapter.identity()) !== payload.genesisHash)
          throw new Error("The Solana ledger changed.");
        if (
          BigInt(
            await this.api.rpc<string>(this.state.networkId, "getBlockHeight", [
              { commitment: "confirmed" },
            ]),
          ) > BigInt(payload.lastValidBlockHeight)
        )
          throw new Error("The signed blockhash expired. Refresh its status.");
      } else if (
        (await adapter.snapshot()).ledgerFingerprint !==
        entry.operation.fingerprint
      )
        throw new Error("The Bitcoin ledger changed.");
      this.assert(g);
      entry.record.state = "submission_unknown";
      await this.saveJournal();
      this.assert(g);
      const hash =
        adapter instanceof EvmAdapter
          ? await adapter.provider.send("eth_sendRawTransaction", [
              entry.signed,
            ])
          : await adapter.broadcast(entry.signed);
      if (hash !== entry.hash)
        throw new Error(
          "Returned hash differs from the saved signed transaction.",
        );
      entry.record.state = "submitted";
      await this.saveJournal();
      this.emit({
        activity: this.journal
          .filter(
            (e) =>
              e.record.networkId === this.state.networkId &&
              e.record.intent.accountId === this.state.selectedAccountId,
          )
          .map((e) => e.record),
      });
    } finally {
      this.signing = false;
    }
  }
  private saveJournal() {
    return this.store.set(
      "journal.testnet.v1",
      JSON.stringify(this.journal.slice(-100)),
    );
  }
  private swapQuote: Awaited<ReturnType<EvmAdapter["quote"]>> | null = null;
  async connectBitcoinWatch() {
    this.assert();
    const g = this.generation,
      account = this.account();
    if (account.family !== "bitcoin")
      throw new Error("Select a Bitcoin account.");
    const watch = new NativeBitcoin(
      this.api,
      nativeBitcoinWatch(this.secret!, account),
    );
    await watch.connect();
    this.assert(g);
    this.bitcoinWatches.set(account.id, watch);
    await this.refresh();
  }
  async quote(amount: string) {
    this.assert();
    const adapter = this.adapter();
    if (
      !(adapter instanceof EvmAdapter) ||
      adapter.profile.environment !== "local"
    )
      throw new Error("Swaps require the verified local pool in this release.");
    this.swapQuote = await adapter.quote(this.account(), amount, "50");
    const state = await adapter.services(this.account());
    return {
      outputSymbol: state.outputToken.symbol,
      outputDecimals: state.outputToken.decimals,
      output: this.swapQuote.output,
      minimum: this.swapQuote.minimum,
      expiresAt: this.swapQuote.expiresAt,
    };
  }
  async prepareSwap(amount: string) {
    this.assert();
    const adapter = this.adapter(),
      q = this.swapQuote;
    if (
      !(adapter instanceof EvmAdapter) ||
      !q ||
      q.expiresAt < Date.now() ||
      q.amountIn !== amount
    )
      throw new Error("Get a fresh quote before reviewing.");
    const manifest = await adapter.manifest();
    if (!manifest) throw new Error("No verified swap deployment.");
    const input = manifest.assets.find(
      (a) => a.standard === "erc20" && a.symbol === "dUSDC",
    );
    if (!input) throw new Error("Swap input token is unavailable.");
    const pool = manifest.contracts.DemoSwapPool.address,
      allowances = await adapter.allowances(this.account()),
      allowance = allowances.find(
        (a) =>
          a.asset.reference.toLowerCase() === input.reference.toLowerCase() &&
          a.spender.toLowerCase() === pool.toLowerCase(),
      );
    const needsApproval = BigInt(allowance?.raw ?? "0") < BigInt(amount);
    return this.prepare({
      requestId: crypto.randomUUID(),
      kind: needsApproval ? "approve" : "swap",
      networkId: this.state.networkId,
      accountId: this.state.selectedAccountId,
      asset: {
        networkId: this.state.networkId,
        standard: "erc20",
        reference: input.reference,
      },
      recipient: pool,
      amount,
      parameters: needsApproval
        ? {}
        : {
            quoteExpiry: String(q.expiresAt),
            minimum: q.minimum,
            deadline: q.deadline,
            quoteId: q.quoteId,
          },
    });
  }
  async reveal(password: string) {
    this.assert();
    const g = this.generation;
    const decoded = await decryptNativeSecret(
      (await this.store.get(this.slot))!,
      password,
    );
    this.assert(g);
    return nativeWords(decoded.secret);
  }
  async changePassword(current: string, next: string, confirmation: string) {
    this.assert();
    validateNativePassword(next, confirmation);
    const g = this.generation,
      decoded = await decryptNativeSecret(
        (await this.store.get(this.slot))!,
        current,
      ),
      envelope = await encryptNativeSecret(
        decoded.secret,
        next,
        this.random,
        decoded.envelope,
      );
    this.assert(g);
    await this.store.set(this.slot, JSON.stringify(envelope));
    this.envelope = envelope;
  }
  async reset(password: string) {
    this.assert();
    const generation = this.generation;
    const target = await this.resetTarget();
    await decryptNativeSecret(target, password);
    this.assert(generation);
    await this.forgetWallet(target, "RESET WALLET", true);
  }
  async resetTarget() {
    const target = await this.store.get(this.slot);
    if (!target) throw new Error("There is no saved wallet to reset.");
    return target;
  }
  async forgetWallet(
    target: string,
    confirmation: string,
    acknowledged: boolean,
  ) {
    if (!acknowledged || confirmation !== "RESET WALLET")
      throw new Error("Confirm your recovery backup and type RESET WALLET.");
    if (!target || (await this.store.get(this.slot)) !== target)
      throw new Error("Wallet data changed. Open the reset screen again.");
    this.lock();
    // Keep the vault if public-data cleanup fails, so removal can be retried.
    await this.store.remove("public.testnet.v1");
    await this.store.remove("journal.testnet.v1");
    await this.store.remove(this.slot);
    this.envelope = null;
    this.journal = [];
    this.emit({
      initialized: false,
      accounts: [],
      selectedAccountId: "",
      balances: [],
      activity: [],
      collectibles: [],
      history: undefined,
      status: "idle",
      updatedAt: null,
    });
  }
}
