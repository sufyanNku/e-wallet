import { DappSessions } from "./dapp";
import { readIndexedHistory } from "./indexed-history";
import {
  bitcoin,
  hex,
  unhex,
  validateRegtestAddress,
  BitcoinAdapter,
  prepareExternalBitcoin,
  bitcoinPayloadSchema,
  bitcoinStatus,
} from "@ewallet/chain-bitcoin";
import { signReviewedBitcoin } from "./bitcoin-signer";
import {
  SolanaAdapter,
  solanaPayloadSchema,
  prepareExternalSolana,
} from "@ewallet/chain-solana";
import { signReviewedSolana } from "./solana-signer";
import { z } from "zod";
import {
  accountRefSchema,
  WalletError,
  assetKey,
  type TransactionIntent,
  type TransactionRecord,
  type PreparedOperation,
  type SwapQuote,
} from "@ewallet/domain";
import { Transaction } from "ethers";
import { EvmAdapter } from "@ewallet/chain-evm";
import { signReviewedEvm } from "./evm-signer";
import { OperationJournal, type JournalEntry } from "./journal";
import { operationDebits, sumDebits } from "./reservations";
import { base64 } from "./vault";
import {
  parseWorkerRequest,
  type WorkerRequest,
  type WorkerReply,
} from "@ewallet/domain/protocol";
import { networks, networkById } from "@ewallet/config";
import { VaultStore } from "./storage";
import {
  seal,
  unseal,
  parseEnvelope,
  validatePassword,
  type VaultSecret,
  type VaultEnvelope,
} from "./vault";
import {
  createSecret,
  importSecret,
  recoveryWords,
  initialAccounts,
  derivePublic,
  specFromAccount,
  bitcoinPublicWatch,
} from "./derivation";
import { ApprovalLedger } from "./approvals";
type PendingCreation = {
  secret: VaultSecret;
  envelope: VaultEnvelope;
  challenge: number[];
};
export class WalletCore {
  private secret: VaultSecret | null = null;
  private pending: PendingCreation | null = null;
  private seen = new Set<string>();
  private lastTouch = Date.now();
  private hiddenAt: number | null = null;
  private autoLock = 5;
  private failedUnlocks = 0;
  private retryAt = 0;
  private lockReason = "New browser window";
  private accountId = "";
  private networkId = "eip155:31337";
  private revision: number | null = null;
  private approvals = new ApprovalLedger();
  private queue: Promise<unknown> = Promise.resolve();
  private initialized: Promise<void>;
  private dapps: DappSessions;
  private externalBroadcasts = new Map<string, string>();
  private externalResults = new Map<string, unknown>();
  private solanaAdapters = new Map<string, SolanaAdapter>();
  private quotes = new Map<
    string,
    { quote: SwapQuote; accountId: string; networkId: string }
  >();
  private adapters = new Map<string, EvmAdapter>();
  constructor(
    readonly store: VaultStore,
    private mode: "local" | "testnet",
    private clock = () => Date.now(),
  ) {
    this.dapps = new DappSessions(
      store,
      async () => {
        this.requireUnlocked();
        await this.assertRevision();
        return {
          account: await this.selectedAccount(),
          networkId: this.networkId,
        };
      },
      (intent) => this.prepareOperation(intent),
      clock,
    );
    this.lastTouch = clock();
    if (mode === "testnet") this.networkId = "eip155:11155111";
    this.initialized = this.loadPreferences();
  }
  private async loadPreferences() {
    const preferred = await this.store.preference(
      "preferredNetwork",
      this.networkId,
    );
    try {
      const network = networkById(preferred);
      if (
        network.environment === this.mode ||
        (this.mode === "testnet" && network.family === "bitcoin")
      )
        this.networkId = network.id;
    } catch {
      /* Unknown profiles fail closed to the mode default. */
    }
    const auto = await this.store.preference<unknown>("autoLockMinutes", 5);
    this.autoLock = auto === 1 || auto === 5 || auto === 15 ? auto : 5;
  }
  dispatch(input: unknown): Promise<WorkerReply> {
    const task = this.queue.then(() => this.handle(input));
    this.queue = task.catch(() => {});
    return task;
  }
  private async handle(input: unknown): Promise<WorkerReply> {
    let id =
      typeof input === "object" &&
      input &&
      "id" in input &&
      typeof input.id === "string" &&
      z.string().uuid().safeParse(input.id).success
        ? input.id
        : crypto.randomUUID();
    try {
      await this.initialized;
      const request = parseWorkerRequest(input);
      id = request.id;
      if (this.seen.has(id))
        throw new WalletError(
          "DUPLICATE_REQUEST",
          "Duplicate Worker request ID.",
        );
      if (this.seen.size >= 4096)
        throw new WalletError(
          "SESSION_LIMIT",
          "Reload and unlock to start a fresh signing session.",
        );
      this.seen.add(id);
      this.checkDeadline();
      const data = await this.execute(request);
      return { protocolVersion: 1, id, ok: true, data };
    } catch (error) {
      const safe =
        error instanceof WalletError
          ? error
          : new WalletError(
              "INVALID_REQUEST",
              "The wallet request could not be completed.",
            );
      return { protocolVersion: 1, id, ok: false, error: safe.toJSON() };
    }
  }
  private lock(reason: string) {
    if (this.secret) {
      this.secret.entropyHex = "";
      this.secret.passphrase = "";
    }
    if (this.pending) {
      this.pending.secret.entropyHex = "";
      this.pending.secret.passphrase = "";
    }
    this.secret = null;
    this.pending = null;
    this.approvals.clear();
    this.quotes.clear();
    this.dapps.clear();
    this.externalResults.clear();
    this.externalBroadcasts.clear();
    this.lockReason = reason;
  }
  private checkDeadline() {
    const now = this.clock();
    if (
      (this.secret || this.pending) &&
      (now - this.lastTouch >= this.autoLock * 60000 ||
        (this.hiddenAt !== null && now - this.hiddenAt >= 60000))
    )
      this.lock("Inactivity or hidden-window timeout");
  }
  private requireUnlocked() {
    this.checkDeadline();
    if (!this.secret)
      throw new WalletError("LOCKED", "Unlock this wallet window to continue.");
    return this.secret;
  }
  async status() {
    await this.initialized;
    this.checkDeadline();
    const envelope = await this.store.envelope();
    const accounts = await this.store.accounts();
    if (this.secret && this.revision !== envelope?.revision)
      this.lock("Wallet changed in another window");
    return {
      initialized: Boolean(envelope),
      locked: !this.secret,
      accounts,
      selectedAccountId:
        this.accountId ||
        accounts.find((a) => a.family === networkById(this.networkId).family)
          ?.id ||
        "",
      networkId: this.networkId,
      autoLockMinutes: this.autoLock,
      lockReason: this.lockReason,
      mode: this.mode,
      revision: envelope?.revision ?? null,
    };
  }
  private async freshUnlock(password: string) {
    if (this.clock() < this.retryAt)
      throw new WalletError(
        "UNLOCK_DELAY",
        "Wait before trying to unlock again.",
        true,
      );
    const envelope = await this.store.envelope();
    if (!envelope)
      throw new WalletError("NO_VAULT", "Create or restore a wallet first.");
    try {
      const secret = await unseal(envelope, password);
      this.failedUnlocks = 0;
      this.retryAt = 0;
      return { secret, envelope };
    } catch (e) {
      this.failedUnlocks++;
      this.retryAt =
        this.clock() +
        Math.min(30000, 500 * 2 ** Math.min(6, this.failedUnlocks - 1));
      throw e;
    }
  }
  private async assertRevision() {
    const envelope = await this.store.envelope();
    if (this.secret && envelope?.revision !== this.revision) {
      this.lock("Wallet changed in another window");
      throw new WalletError(
        "SESSION_INVALIDATED",
        "Wallet data changed. Unlock again.",
      );
    }
  }
  private async activate(secret: VaultSecret, envelope: VaultEnvelope) {
    this.lock("New unlocked session");
    this.secret = secret;
    this.revision = envelope.revision;
    this.lastTouch = this.clock();
    this.hiddenAt = null;
    const accounts = await this.store.accounts();
    const preferred = await this.store.preference("selectedAccountId", "");
    this.accountId =
      accounts.find(
        (a) =>
          a.id === preferred && a.family === networkById(this.networkId).family,
      )?.id ??
      accounts.find((a) => a.family === networkById(this.networkId).family)
        ?.id ??
      "";
    this.lockReason = "";
    return this.status();
  }
  private async execute(request: WorkerRequest): Promise<unknown> {
    const p = request.payload;
    switch (request.method) {
      case "portfolio.historyMore": {
        this.requireUnlocked();
        await this.assertRevision();
        return readIndexedHistory(
          await this.selectedAccount(),
          this.networkId,
          [],
          request.payload.watchId,
          request.payload.cursor,
        );
      }
      case "session.status":
        return this.status();
      case "permissions.list":
        return this.dapps.permissions();
      case "permissions.revoke":
        await this.dapps.revoke(request.payload.id);
        return { revoked: true };
      case "dapp.open":
        return this.dapps.open(request.payload.origin, request.payload.request);
      case "dapp.grant":
        return this.dapps.grant(request.payload.channel);
      case "dapp.switch": {
        this.requireUnlocked();
        await this.assertRevision();
        const { chainId, context } = await this.dapps.switchNetwork(
            request.payload.channel,
          ),
          target = networks.find(
            (n) =>
              n.family === "evm" &&
              n.identity === chainId &&
              n.environment === this.mode,
          );
        if (!target)
          throw new WalletError(
            "UNKNOWN_NETWORK",
            "Only an approved network in the current mode can be selected.",
          );
        this.networkId = target.id;
        await this.store.setPreference("preferredNetwork", target.id);
        this.approvals.clear();
        await this.evm().identity();
        await this.dapps.grant(request.payload.channel);
        const result = await this.dapps.publicResult(request.payload.channel);
        context.consumed = true;
        return result;
      }
      case "dapp.read":
        return this.dapps.publicResult(request.payload.channel);
      case "dapp.disconnect":
        return this.dapps.disconnect(request.payload.channel);
      case "dapp.prepare": {
        const context = this.dapps.require(request.payload.channel);
        if (
          context.request.family !== "evm" &&
          !["solana:signMessage"].includes(context.request.method)
        )
          return {
            kind: "transaction",
            operation: await this.dapps.prepareExternal(
              request.payload.channel,
              async (ctx, account) => {
                if (ctx.request.family === "solana") {
                  if (
                    ![
                      "solana:signTransaction",
                      "solana:signAndSendTransaction",
                    ].includes(ctx.request.method)
                  )
                    throw new WalletError(
                      "UNSUPPORTED_METHOD",
                      "Not a Solana transaction request.",
                    );
                  const params = z
                    .object({
                      transaction: z.string().max(5000),
                      account: z.string().optional(),
                      networkId: z.string().optional(),
                    })
                    .strict()
                    .parse(ctx.request.params[0]);
                  if (
                    (params.account && params.account !== account.address) ||
                    (params.networkId && params.networkId !== this.networkId)
                  )
                    throw new WalletError(
                      "SIGNER",
                      "Dapp transaction signer or network differs.",
                    );
                  return this.prepareSolana(null, account, {
                    transaction: params.transaction,
                    origin: ctx.origin,
                    requestId: ctx.request.requestId,
                  });
                }
                if (ctx.request.method === "bitcoin:broadcastTransaction")
                  return this.prepareBitcoinBroadcast(
                    ctx.request.params[0],
                    ctx.origin,
                    ctx.request.requestId,
                    account,
                  );
                if (ctx.request.method !== "bitcoin:signPsbt")
                  throw new WalletError(
                    "UNSUPPORTED_METHOD",
                    "Use a separately approved signed transaction to broadcast.",
                  );
                return this.prepareBitcoin(null, {
                  input: ctx.request.params[0],
                  origin: ctx.origin,
                  requestId: ctx.request.requestId,
                });
              },
            ),
          };
        return [
          "personal_sign",
          "eth_signTypedData_v4",
          "solana:signMessage",
        ].includes(context.request.method)
          ? {
              kind: "message",
              review: await this.dapps.prepareMessage(request.payload.channel),
            }
          : {
              kind: "transaction",
              operation: await this.dapps.prepareEvm(request.payload.channel),
            };
      }
      case "dapp.signMessage": {
        this.requireUnlocked();
        await this.assertRevision();
        if (networkById(this.networkId).family === "evm")
          await this.evm().identity();
        else if (networkById(this.networkId).family === "solana")
          await this.solana().identity();
        const secret = this.requireUnlocked();
        await this.assertRevision();
        return this.dapps.signMessage(
          request.payload.channel,
          request.payload.messageId,
          request.payload.digest,
          secret,
        );
      }
      case "dapp.execute": {
        const { context } = await this.dapps.requireOperation(
          request.payload.channel,
          request.payload.operationId,
        );
        this.requireUnlocked();
        await this.assertRevision();
        this.approvals.approve(
          request.payload.operationId,
          request.payload.digest,
          this.accountId,
          this.networkId,
        );
        this.dapps.consume(request.payload.channel);
        const signOnly = [
            "solana:signTransaction",
            "bitcoin:signPsbt",
          ].includes(context.request.method),
          record = signOnly
            ? context.request.family === "solana"
              ? await this.executeSolana(request.payload.operationId, true)
              : await this.executeBitcoin(request.payload.operationId, true)
            : context.request.method === "bitcoin:broadcastTransaction"
              ? await this.broadcastBitcoinApproved(request.payload.operationId)
              : await this.executeOperation(request.payload.operationId);
        if (signOnly) {
          const result = this.externalResults.get(record.id);
          this.externalResults.delete(record.id);
          return result;
        }
        return {
          hash: record.hash,
          state: record.state,
          networkId: record.networkId,
          requestId: context.request.requestId,
        };
      }
      case "session.touch":
        if (this.secret || this.pending) this.lastTouch = this.clock();
        return this.status();
      case "session.visibility":
        this.hiddenAt = request.payload.hidden
          ? (this.hiddenAt ?? this.clock())
          : null;
        return this.status();
      case "session.settings":
        this.requireUnlocked();
        this.autoLock = request.payload.autoLockMinutes;
        await this.store.setPreference("autoLockMinutes", this.autoLock);
        return this.status();
      case "vault.lock":
        this.lock(request.payload.reason);
        return this.status();
      case "vault.create": {
        if (await this.store.envelope())
          throw new WalletError(
            "VAULT_EXISTS",
            "Reset or explicitly replace the existing wallet after backing it up.",
          );
        validatePassword(
          request.payload.password,
          request.payload.confirmation,
        );
        const secret = createSecret(request.payload.passphrase),
          envelope = await seal(secret, request.payload.password);
        await unseal(envelope, request.payload.password);
        const challenge = Array.from(
          crypto.getRandomValues(new Uint32Array(3)),
          (n, i) => i * 8 + (n % 8),
        );
        this.pending = { secret, envelope, challenge };
        this.lastTouch = this.clock();
        return { words: recoveryWords(secret), challenge };
      }
      case "vault.backupConfirm": {
        const pending = this.pending;
        if (!pending)
          throw new WalletError(
            "BACKUP_EXPIRED",
            "Creation session expired. Start again.",
          );
        const words = recoveryWords(pending.secret);
        if (
          !request.payload.acknowledged ||
          request.payload.answers.some(
            (a, i) => a !== words[pending.challenge[i]],
          )
        )
          throw new WalletError(
            "BACKUP_CHECK",
            "Confirm the backup and enter the three requested words.",
          );
        const accounts = initialAccounts(
          pending.secret,
          pending.envelope.walletId,
        );
        await this.store.commit(pending.envelope, null, accounts);
        this.pending = null;
        return this.activate(pending.secret, pending.envelope);
      }
      case "vault.import": {
        if (await this.store.envelope())
          throw new WalletError(
            "VAULT_EXISTS",
            "Back up and reset the current wallet before restoring another root.",
          );
        validatePassword(
          request.payload.password,
          request.payload.confirmation,
        );
        const secret = importSecret(
            request.payload.mnemonic,
            request.payload.passphrase,
          ),
          envelope = await seal(secret, request.payload.password);
        await unseal(envelope, request.payload.password);
        await this.store.commit(
          envelope,
          null,
          initialAccounts(secret, envelope.walletId),
        );
        return this.activate(secret, envelope);
      }
      case "vault.unlock": {
        const { secret, envelope } = await this.freshUnlock(
          request.payload.password,
        );
        return this.activate(secret, envelope);
      }
      case "vault.changePassword": {
        this.requireUnlocked();
        await this.assertRevision();
        validatePassword(request.payload.next, request.payload.confirmation);
        const { secret, envelope } = await this.freshUnlock(
          request.payload.current,
        );
        const next = await seal(secret, request.payload.next, {
          ...envelope,
          revision: envelope.revision + 1,
        });
        await unseal(next, request.payload.next);
        await this.store.commit(next, envelope.revision, undefined, true);
        return this.activate(secret, next);
      }
      case "vault.revealRecovery": {
        this.requireUnlocked();
        await this.assertRevision();
        const { secret } = await this.freshUnlock(request.payload.password);
        return {
          words: recoveryWords(secret),
          expiresAt: this.clock() + 30000,
        };
      }
      case "vault.exportEncrypted": {
        this.requireUnlocked();
        await this.assertRevision();
        const { envelope } = await this.freshUnlock(request.payload.password);
        return JSON.stringify({
          schemaVersion: 1,
          mode: this.mode,
          envelope,
          accounts: await this.store.accounts(),
        });
      }
      case "vault.restoreEncrypted": {
        if (!request.payload.acknowledged)
          throw new WalletError(
            "BACKUP_ACK",
            "Acknowledge your current backup before replacing browser data.",
          );
        const backup = z
          .object({
            schemaVersion: z.literal(1),
            mode: z.enum(["local", "testnet"]),
            envelope: z.unknown(),
            accounts: z.array(accountRefSchema).max(100),
          })
          .strict()
          .parse(JSON.parse(request.payload.envelopeJson));
        if (backup.mode !== this.mode)
          throw new WalletError(
            "MODE_MISMATCH",
            "Restore backups only into their original data mode.",
          );
        const envelope = parseEnvelope(backup.envelope),
          secret = await unseal(envelope, request.payload.password);
        for (const account of backup.accounts) {
          const derived = derivePublic(
            secret,
            envelope.walletId,
            specFromAccount(account),
          );
          if (
            derived.address !== account.address ||
            derived.id !== account.id ||
            account.rootWalletId !== envelope.walletId
          )
            throw new WalletError(
              "RESTORE_METADATA",
              "Public backup metadata does not match the encrypted root.",
            );
        }
        const current = await this.store.envelope();
        if (current)
          throw new WalletError(
            "VAULT_EXISTS",
            "Back up and reset the current wallet before restoring an encrypted root.",
          );
        await this.store.commit(
          envelope,
          null,
          backup.accounts.length
            ? backup.accounts
            : initialAccounts(secret, envelope.walletId),
        );
        return this.activate(secret, envelope);
      }
      case "vault.reset": {
        this.requireUnlocked();
        if (!request.payload.acknowledged)
          throw new WalletError(
            "BACKUP_ACK",
            "Acknowledge that your recovery backup is safe.",
          );
        await this.assertRevision();
        const { envelope } = await this.freshUnlock(request.payload.password);
        await this.store.reset(envelope.revision);
        this.lock("Wallet reset");
        this.revision = null;
        return this.status();
      }
      case "accounts.list":
        return (await this.status()).accounts;
      case "portfolio.refresh":
        return this.refreshPortfolio();
      case "bitcoin.watch": {
        const secret = this.requireUnlocked();
        await this.assertRevision();
        const account = await this.selectedAccount();
        if (account.family !== "bitcoin")
          throw new WalletError("ACCOUNT", "Select a Bitcoin account.");
        const watch = bitcoinPublicWatch(secret, account);
        await new BitcoinAdapter().register(watch);
        await this.store.setPreference(
          "bitcoinWatchConsent:" + account.id,
          true,
        );
        return { authorized: true };
      }
      case "bitcoin.receive": {
        const { account, watch, watchId, adapter } =
          await this.bitcoinContext();
        const state = await adapter.refresh(watch, watchId),
          index = Math.max(
            0,
            (state.discovery.find((d) => d.change === 0)?.lastUsed ?? -1) + 1,
          ),
          derived = await adapter.nextAddress(watch, watchId, 0, index);
        await this.store.setPreference(
          "bitcoinReceive:" + account.id,
          derived.address,
        );
        return { address: derived.address };
      }
      case "services.state":
        this.requireUnlocked();
        await this.assertRevision();
        return this.evm().services(await this.selectedAccount());
      case "services.quote": {
        this.requireUnlocked();
        await this.assertRevision();
        for (const [id, cached] of this.quotes)
          if (cached.quote.expiresAt < this.clock()) this.quotes.delete(id);
        if (this.quotes.size >= 20)
          throw new WalletError(
            "REQUEST_LIMIT",
            "Resolve or wait for existing quotes to expire.",
          );
        const quote = await this.evm().quote(
          await this.selectedAccount(),
          request.payload.amount,
          request.payload.slippageBps,
        );
        this.quotes.set(quote.quoteId, {
          quote,
          accountId: this.accountId,
          networkId: this.networkId,
        });
        return quote;
      }
      case "assets.import": {
        this.requireUnlocked();
        await this.assertRevision();
        const metadata = await this.evm().tokenMetadata(
          request.payload.reference,
        );
        if (
          metadata.decimals !== request.payload.decimals ||
          metadata.symbol !== request.payload.symbol
        )
          throw new WalletError(
            "TOKEN_METADATA",
            "Entered precision differs from the on-chain token. Review its metadata.",
          );
        const key = `customTokens:${this.networkId}`,
          tokens = await this.store.preference<
            Array<{
              reference: string;
              symbol: string;
              name: string;
              decimals: number;
            }>
          >(key, []);
        if (
          tokens.some(
            (t) => t.reference.toLowerCase() === metadata.address.toLowerCase(),
          )
        )
          throw new WalletError(
            "DUPLICATE_ASSET",
            "This token is already imported.",
          );
        await this.store.setPreference(key, [
          ...tokens,
          {
            reference: metadata.address,
            symbol: metadata.symbol,
            name: metadata.name,
            decimals: metadata.decimals,
          },
        ]);
        return metadata;
      }
      case "assets.hide": {
        this.requireUnlocked();
        const key = `hiddenAssets:${this.networkId}`,
          hidden = await this.store.preference<Record<string, boolean>>(
            key,
            {},
          );
        await this.store.setPreference(key, {
          ...hidden,
          [request.payload.key]: request.payload.hidden,
        });
        return { updated: true };
      }
      case "accounts.derive": {
        const secret = this.requireUnlocked();
        await this.assertRevision();
        const envelope = (await this.store.envelope())!;
        const account = derivePublic(
          secret,
          envelope.walletId,
          request.payload,
        );
        const accounts = await this.store.accounts();
        if (
          accounts.some(
            (a) => a.path === account.path && a.family === account.family,
          )
        )
          throw new WalletError(
            "DUPLICATE_ACCOUNT",
            "This derivation path already exists.",
          );
        await this.store.saveAccounts([account]);
        return account;
      }
      case "accounts.select": {
        this.requireUnlocked();
        await this.assertRevision();
        const account = (await this.store.accounts()).find(
          (a) => a.id === request.payload.accountId,
        );
        if (!account || account.family !== networkById(this.networkId).family)
          throw new WalletError(
            "ACCOUNT_MISMATCH",
            "Choose an account in the selected network family.",
          );
        this.accountId = account.id;
        this.approvals.clear();
        await this.store.setPreference("selectedAccountId", account.id);
        return this.status();
      }
      case "accounts.rename": {
        this.requireUnlocked();
        await this.assertRevision();
        const account = (await this.store.accounts()).find(
          (a) => a.id === request.payload.accountId,
        );
        if (!account) throw new WalletError("ACCOUNT", "Account not found.");
        await this.store.saveAccounts([
          { ...account, name: request.payload.name },
        ]);
        return this.status();
      }
      case "accounts.discovery": {
        const secret = this.requireUnlocked();
        await this.assertRevision();
        if (request.payload.family !== networkById(this.networkId).family)
          throw new WalletError(
            "WRONG_NETWORK",
            "Select a network in the account family you want to discover.",
          );
        if (request.payload.family === "bitcoin") {
          const { account, adapter, watch, watchId } =
              await this.bitcoinContext(),
            state = await adapter.refresh(watch, watchId);
          return {
            source: "node",
            networkId: this.networkId,
            accounts: [account],
            derivations: state.discovery,
            utxoCount: state.utxos.length,
            observedHeight: state.height,
            coverage:
              "Consented account only, imported receive/change range 0–999 with a gap of 20 beyond known/allocated addresses. Additional hardened accounts require their own consent.",
          };
        }
        const envelope = (await this.store.envelope())!,
          accounts = Array.from({ length: request.payload.count }, (_, i) =>
            derivePublic(secret, envelope.walletId, {
              family: request.payload.family,
              index: request.payload.start + i,
            }),
          );
        const scan =
            request.payload.family === "evm"
              ? await this.evm().discoverAccounts(accounts)
              : await this.solana().discoverAccounts(accounts),
          existing = await this.store.accounts(),
          recovered = scan.results
            .filter(
              (r) => r.used && !existing.some((a) => a.id === r.account.id),
            )
            .map((r) => r.account);
        this.requireUnlocked();
        await this.assertRevision();
        if (recovered.length) await this.store.saveAccounts(recovered);
        return {
          source: "node",
          networkId: this.networkId,
          accounts,
          usedAccounts: scan.results
            .filter((r) => r.used)
            .map((r) => r.account.id),
          recovered: recovered.length,
          observedHeight: scan.height,
          coverage: scan.coverage,
          start: request.payload.start,
          next: request.payload.start + request.payload.count,
        };
      }
      case "network.select": {
        const network = networkById(request.payload.networkId);
        if (
          network.environment !== this.mode &&
          !(this.mode === "testnet" && network.family === "bitcoin")
        )
          throw new WalletError(
            "MODE_MISMATCH",
            "This network is not signable in the current data mode.",
          );
        this.networkId = network.id;
        await this.store.setPreference("preferredNetwork", network.id);
        this.accountId =
          (await this.store.accounts()).find((a) => a.family === network.family)
            ?.id ?? "";
        this.approvals.clear();
        return this.status();
      }
      case "operation.max":
        return this.maximumAmount(request.payload);
      case "operation.prepare":
        return this.prepareOperation(request.payload);
      case "operation.review":
        this.requireUnlocked();
        return this.approvals.review(request.payload.operationId);
      case "operation.approve":
        this.requireUnlocked();
        await this.assertRevision();
        this.approvals.approve(
          request.payload.operationId,
          request.payload.digest,
          this.accountId,
          this.networkId,
        );
        return { approved: true };
      case "operation.reject":
        this.approvals.reject(request.payload.operationId);
        await this.rejectOperation(request.payload.operationId);
        return { rejected: true };
      case "operation.execute":
        return this.executeOperation(request.payload.operationId);
      case "operation.status":
        return { state: this.approvals.status(request.payload.operationId) };
      default:
        void p;
        throw new WalletError(
          "UNSUPPORTED_METHOD",
          "This method is not supported.",
        );
    }
  }
  private solana() {
    let adapter = this.solanaAdapters.get(this.networkId);
    if (!adapter) {
      adapter = new SolanaAdapter(this.networkId);
      this.solanaAdapters.set(this.networkId, adapter);
    }
    return adapter;
  }
  private async pendingSolana(
    journal: OperationJournal,
    accountId: string,
    genesis: string,
  ) {
    const operations: PreparedOperation[] = [];
    for (const entry of await journal.entries()) {
      if (
        entry.operation.intent.accountId !== accountId ||
        entry.operation.intent.networkId !== this.networkId
      )
        continue;
      if (
        ["review_ready", "awaiting_approval"].includes(entry.state) &&
        entry.operation.expiresAt <= this.clock()
      ) {
        await journal.transition(entry.id, entry.state, "expired");
        continue;
      }
      if (
        ![
          "review_ready",
          "awaiting_approval",
          "signing",
          "signed",
          "submitted",
          "submission_unknown",
        ].includes(entry.state)
      )
        continue;
      if (
        solanaPayloadSchema.parse(JSON.parse(entry.operation.encodedPayload))
          .genesisHash === genesis
      )
        operations.push(entry.operation);
    }
    return sumDebits(operations);
  }
  private async prepareSolana(
    intent: TransactionIntent | null,
    account: Awaited<ReturnType<WalletCore["selectedAccount"]>>,
    external?: { transaction: string; origin: string; requestId: string },
  ) {
    return this.store.exclusive(
      `solana-spend:${this.networkId}:${account.address}`,
      async () => {
        const adapter = this.solana(),
          operation = external
            ? await prepareExternalSolana(
                adapter,
                external.transaction,
                account,
                external.origin,
                external.requestId,
              )
            : await adapter.prepare(intent!, account),
          journal = new OperationJournal(this.store),
          genesis = solanaPayloadSchema.parse(
            JSON.parse(operation.encodedPayload),
          ).genesisHash;
        const pending = await this.pendingSolana(journal, account.id, genesis),
          portfolio = await adapter.portfolio(account);
        for (const [key, raw] of operationDebits(operation)) {
          const balance = portfolio.balances.find(
              (b) => assetKey(b.asset) === key,
            ),
            collectible = portfolio.collectibles.find(
              (c) => assetKey(c.asset) === key,
            );
          if (
            raw + (pending.get(key) ?? 0n) >
            BigInt(balance?.available ?? collectible?.quantity ?? "0")
          )
            throw new WalletError(
              "RESERVED_FUNDS",
              "Balance is reserved by another pending Solana operation.",
            );
        }
        await journal.create(operation);
        await journal.transition(
          operation.id,
          "review_ready",
          "awaiting_approval",
        );
        return this.approvals.register(operation);
      },
    );
  }
  private async executeSolana(id: string, signOnly = false) {
    this.requireUnlocked();
    await this.assertRevision();
    const op = this.approvals.consume(id),
      account = await this.selectedAccount(),
      adapter = this.solana(),
      journal = new OperationJournal(this.store);
    if (
      op.intent.accountId !== account.id ||
      op.intent.networkId !== this.networkId
    )
      throw new WalletError("WRONG_NETWORK", "Account or network changed.");
    await journal.transition(id, "awaiting_approval", "signing");
    let result: Awaited<ReturnType<typeof signReviewedSolana>>;
    try {
      const payload = await adapter.revalidate(op, account);
      this.approvals.review(id);
      await this.assertRevision();
      result = await signReviewedSolana(
        this.requireUnlocked(),
        account,
        payload,
      );
    } catch (error) {
      await journal.transition(id, "signing", "rejected");
      throw error;
    }
    await journal.transition(id, "signing", "signed", {
      expectedIdentifier: result.signature,
      signedBytesBase64: result.signed,
    });
    if (signOnly) {
      this.externalResults.set(id, {
        signedTransaction: result.signed,
        signature: result.signature,
        networkId: this.networkId,
      });
      return this.record((await journal.get(id))!);
    }
    try {
      const observed = await adapter.broadcast(result.signed);
      if (observed !== result.signature)
        throw new Error("Unexpected transaction identifier");
      await journal.transition(id, "signed", "submitted");
    } catch {
      await journal.transition(id, "signed", "submission_unknown");
      return this.record((await journal.get(id))!);
    }
    const entry = await this.reconcileSolana((await journal.get(id))!, journal);
    return this.record(entry);
  }
  private async reconcileSolana(
    entry: JournalEntry,
    journal: OperationJournal,
  ) {
    if (!entry.expectedIdentifier) return entry;
    const payload = solanaPayloadSchema.parse(
      JSON.parse(entry.operation.encodedPayload),
    );
    if ((await this.solana().identity()) !== payload.genesisHash) return entry;
    if (entry.state === "signed") {
      await journal.transition(entry.id, "signed", "submission_unknown");
      entry = (await journal.get(entry.id))!;
    }
    if (
      ![
        "submission_unknown",
        "submitted",
        "included",
        "confirmed",
        "finalized",
      ].includes(entry.state)
    )
      return entry;
    const observation = await this.solana().status(
      entry.expectedIdentifier!,
      payload.lastValidBlockHeight,
    );
    await journal.observe(entry.id, entry.expectedIdentifier!, observation);
    if (["included", "confirmed", "finalized"].includes(observation.state)) {
      if (["submitted", "submission_unknown"].includes(entry.state)) {
        await journal.transition(entry.id, entry.state, "included");
        entry = (await journal.get(entry.id))!;
      }
      if (observation.state === "confirmed" && entry.state === "included") {
        await journal.transition(entry.id, "included", "confirmed");
        entry = (await journal.get(entry.id))!;
      }
      if (
        observation.state === "finalized" &&
        ["included", "confirmed"].includes(entry.state)
      )
        await journal.transition(entry.id, entry.state, "finalized");
    } else if (
      observation.state === "reverted" &&
      ["submitted", "submission_unknown", "included"].includes(entry.state)
    )
      await journal.transition(entry.id, entry.state, "reverted");
    else if (
      observation.state === "expired" &&
      ["submitted", "submission_unknown"].includes(entry.state)
    )
      await journal.transition(entry.id, entry.state, "expired");
    return (await journal.get(entry.id))!;
  }
  private async refreshSolana() {
    this.requireUnlocked();
    await this.assertRevision();
    const account = await this.selectedAccount(),
      adapter = this.solana(),
      journal = new OperationJournal(this.store),
      genesis = await adapter.identity(),
      portfolio = await adapter.portfolio(account),
      activity: TransactionRecord[] = [];
    for (let entry of (await journal.entries()).filter(
      (e) =>
        e.operation.intent.accountId === account.id &&
        e.operation.intent.networkId === this.networkId,
    )) {
      const payload = solanaPayloadSchema.parse(
        JSON.parse(entry.operation.encodedPayload),
      );
      if (payload.genesisHash !== genesis) {
        activity.push({
          ...this.record(entry),
          state: "orphaned",
          reorg: true,
        });
        continue;
      }
      entry = await this.reconcileSolana(entry, journal);
      activity.push(this.record(entry));
    }
    const pending = await this.pendingSolana(journal, account.id, genesis);
    return {
      ...portfolio,
      balances: portfolio.balances.map((b) => {
        const reserve = pending.get(assetKey(b.asset)) ?? 0n,
          available = BigInt(b.available),
          r = reserve > available ? available : reserve;
        return { ...b, available: String(available - r), reserved: String(r) };
      }),
      ...(await this.indexed(account, activity)),
    };
  }
  private async bitcoinContext() {
    const secret = this.requireUnlocked();
    await this.assertRevision();
    const account = await this.selectedAccount();
    if (account.family !== "bitcoin")
      throw new WalletError("ACCOUNT", "Select a Bitcoin account.");
    if (
      !(await this.store.preference("bitcoinWatchConsent:" + account.id, false))
    )
      throw new WalletError(
        "WATCH_CONSENT",
        "Enable watch-only discovery after reviewing the public-descriptor privacy explanation.",
      );
    const watch = bitcoinPublicWatch(secret, account),
      adapter = new BitcoinAdapter(),
      registered = await adapter.register(watch);
    const identity = await adapter.identity();
    return {
      account,
      watch,
      watchId: registered.watchId,
      historyWatchId: registered.historyWatchId,
      adapter,
      ledgerFingerprint: identity.ledgerFingerprint,
    };
  }
  private async bitcoinReserved(accountId: string, ledgerFingerprint: string) {
    const journal = new OperationJournal(this.store),
      reserved = new Set<string>();
    for (const entry of await journal.entries()) {
      if (
        entry.operation.intent.networkId !== "bitcoin:regtest" ||
        entry.operation.intent.accountId !== accountId
      )
        continue;
      if (
        ["review_ready", "awaiting_approval"].includes(entry.state) &&
        entry.operation.expiresAt <= this.clock()
      ) {
        await journal.transition(entry.id, entry.state, "expired");
        continue;
      }
      if (
        ![
          "review_ready",
          "awaiting_approval",
          "signing",
          "signed",
          "submitted",
          "submission_unknown",
          "orphaned",
        ].includes(entry.state)
      )
        continue;
      const payload = bitcoinPayloadSchema.parse(
        JSON.parse(entry.operation.encodedPayload),
      );
      if (payload.ledgerFingerprint !== ledgerFingerprint) continue;
      for (const input of payload.inputs)
        reserved.add(input.txid + ":" + input.vout);
    }
    return reserved;
  }
  private async prepareBitcoin(
    intent: TransactionIntent | null,
    external?: { input: unknown; origin: string; requestId: string },
  ) {
    const context = await this.bitcoinContext();
    return this.store.exclusive(
      "bitcoin-utxos:" + context.watch.xpub,
      async () => {
        const operation = external
            ? await prepareExternalBitcoin(
                context.adapter,
                external.input,
                context.account,
                context.watch,
                context.watchId,
                await this.bitcoinReserved(
                  context.account.id,
                  context.ledgerFingerprint,
                ),
                external.origin,
                external.requestId,
              )
            : await context.adapter.prepare(
                intent!,
                context.account,
                context.watch,
                context.watchId,
                await this.bitcoinReserved(
                  context.account.id,
                  context.ledgerFingerprint,
                ),
              ),
          journal = new OperationJournal(this.store);
        await journal.create(operation);
        await journal.transition(
          operation.id,
          "review_ready",
          "awaiting_approval",
        );
        return this.approvals.register(operation);
      },
    );
  }
  private async prepareBitcoinBroadcast(
    input: unknown,
    origin: string,
    requestId: string,
    account: Awaited<ReturnType<WalletCore["selectedAccount"]>>,
  ) {
    const { transaction } = z
        .object({
          transaction: z
            .string()
            .regex(/^(?:[a-f0-9]{2})+$/i)
            .max(100000),
        })
        .strict()
        .parse(input),
      tx = bitcoin.Transaction.fromHex(transaction),
      journal = new OperationJournal(this.store),
      entry = (await journal.entries()).find(
        (e) =>
          ["signed", "submission_unknown"].includes(e.state) &&
          e.expectedIdentifier === tx.getId() &&
          e.operation.intent.origin === origin &&
          e.operation.intent.accountId === account.id &&
          e.operation.intent.networkId === this.networkId &&
          e.signedBytesBase64 &&
          hex(
            Uint8Array.from(atob(e.signedBytesBase64), (c) => c.charCodeAt(0)),
          ) === transaction.toLowerCase(),
      );
    if (!entry)
      throw new WalletError(
        "BROADCAST_POLICY",
        "Only the exact transaction previously signed for this origin, account and network can be broadcast.",
      );
    await new BitcoinAdapter().revalidate(entry.operation);
    const now = this.clock(),
      operation: PreparedOperation = {
        ...entry.operation,
        id: crypto.randomUUID(),
        intent: { ...entry.operation.intent, requestId },
        createdAt: now,
        expiresAt: now + 60000,
        preview: {
          ...entry.operation.preview,
          title: "Broadcast previously signed Bitcoin transaction",
          warnings: [
            ...entry.operation.preview.warnings,
            "No new signature is created. Broadcasting submits the exact previously approved transaction.",
          ],
        },
      };
    operation.digest = hex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify({
              intent: operation.intent,
              payload: operation.encodedPayload,
              expiresAt: operation.expiresAt,
              transaction,
            }),
          ),
        ),
      ),
    );
    await journal.create(operation);
    await journal.transition(operation.id, "review_ready", "awaiting_approval");
    this.externalBroadcasts.set(operation.id, transaction);
    return this.approvals.register(operation);
  }
  private async broadcastBitcoinApproved(id: string) {
    const operation = this.approvals.consume(id),
      signed = this.externalBroadcasts.get(id);
    this.externalBroadcasts.delete(id);
    if (!signed)
      throw new WalletError(
        "BROADCAST_POLICY",
        "The bound signed transaction is unavailable; review again.",
      );
    const adapter = new BitcoinAdapter(),
      journal = new OperationJournal(this.store);
    await adapter.revalidate(operation);
    const txid = bitcoin.Transaction.fromHex(signed).getId();
    await journal.transition(id, "awaiting_approval", "signing");
    await journal.transition(id, "signing", "signed", {
      expectedIdentifier: txid,
      signedBytesBase64: base64(unhex(signed)),
    });
    try {
      if ((await adapter.broadcast(signed)) !== txid)
        throw new Error("Unexpected txid");
      await journal.transition(id, "signed", "submitted");
    } catch {
      await journal.transition(id, "signed", "submission_unknown");
    }
    return this.record((await journal.get(id))!);
  }
  private async executeBitcoin(id: string, signOnly = false) {
    const { account, adapter } = await this.bitcoinContext(),
      operation = this.approvals.consume(id),
      journal = new OperationJournal(this.store);
    if (
      operation.intent.accountId !== account.id ||
      operation.intent.networkId !== this.networkId
    )
      throw new WalletError("WRONG_NETWORK", "Account or network changed.");
    await journal.transition(id, "awaiting_approval", "signing");
    let signed: ReturnType<typeof signReviewedBitcoin>;
    try {
      const payload = await adapter.revalidate(operation);
      this.approvals.review(id);
      await this.assertRevision();
      signed = signReviewedBitcoin(this.requireUnlocked(), account, payload);
    } catch (error) {
      await journal.transition(id, "signing", "rejected");
      throw error;
    }
    await journal.transition(id, "signing", "signed", {
      expectedIdentifier: signed.txid,
      signedBytesBase64: base64(
        new Uint8Array(signed.signed.match(/../g)!.map((b) => parseInt(b, 16))),
      ),
    });
    if (signOnly) {
      this.externalResults.set(id, {
        psbt: signed.psbt,
        transaction: signed.signed,
        txid: signed.txid,
        networkId: this.networkId,
      });
      return this.record((await journal.get(id))!);
    }
    try {
      if ((await adapter.broadcast(signed.signed)) !== signed.txid)
        throw new Error("Unexpected txid");
      await journal.transition(id, "signed", "submitted");
    } catch {
      await journal.transition(id, "signed", "submission_unknown");
    }
    return this.record((await journal.get(id))!);
  }
  private async refreshBitcoin() {
    const {
        account,
        watch,
        watchId,
        adapter,
        ledgerFingerprint,
        historyWatchId,
      } = await this.bitcoinContext(),
      journal = new OperationJournal(this.store),
      activity: TransactionRecord[] = [];
    for (let entry of (await journal.entries()).filter(
      (e) =>
        e.operation.intent.accountId === account.id &&
        e.operation.intent.networkId === this.networkId,
    )) {
      if (
        bitcoinPayloadSchema.parse(JSON.parse(entry.operation.encodedPayload))
          .ledgerFingerprint !== ledgerFingerprint
      ) {
        activity.push({
          ...this.record(entry),
          state: "orphaned",
          reorg: true,
        });
        continue;
      }
      if (entry.state === "signed") {
        await journal.transition(entry.id, "signed", "submission_unknown");
        entry = (await journal.get(entry.id))!;
      }
      if (
        entry.expectedIdentifier &&
        [
          "submitted",
          "submission_unknown",
          "included",
          "confirmed",
          "orphaned",
        ].includes(entry.state)
      ) {
        const observation = await bitcoinStatus(entry.expectedIdentifier),
          payload = bitcoinPayloadSchema.parse(
            JSON.parse(entry.operation.encodedPayload),
          );
        observation.fee = null;
        await journal.observe(entry.id, entry.expectedIdentifier, {
          ...observation,
          fee: payload.fee,
        });
        if (["included", "confirmed"].includes(observation.state)) {
          if (
            ["submitted", "submission_unknown", "orphaned"].includes(
              entry.state,
            )
          ) {
            await journal.transition(entry.id, entry.state, "included");
            entry = (await journal.get(entry.id))!;
          }
          if (observation.state === "confirmed" && entry.state === "included")
            await journal.transition(entry.id, "included", "confirmed");
        } else if (
          ["submitted", "submission_unknown", "orphaned"].includes(
            observation.state,
          ) &&
          ["included", "confirmed"].includes(entry.state)
        )
          await journal.transition(entry.id, entry.state, "orphaned");
      }
      activity.push(this.record((await journal.get(entry.id))!));
    }
    const { balance } = await adapter.balances(
      watch,
      watchId,
      await this.bitcoinReserved(account.id, ledgerFingerprint),
    );
    return {
      balances: [balance],
      collectibles: [],
      allowances: [],
      ...(await this.indexed(account, activity, historyWatchId)),
      observedAt: balance.observation.observedAt,
      receiveAddress: await this.store.preference(
        "bitcoinReceive:" + account.id,
        account.address,
      ),
    };
  }
  private evm() {
    if (networkById(this.networkId).family !== "evm")
      throw new WalletError(
        "ADAPTER_UNAVAILABLE",
        "This network connection is unavailable.",
      );
    let adapter = this.adapters.get(this.networkId);
    if (!adapter) {
      adapter = new EvmAdapter(this.networkId);
      this.adapters.set(this.networkId, adapter);
    }
    return adapter;
  }
  private async selectedAccount() {
    const account = (await this.store.accounts()).find(
      (a) => a.id === this.accountId,
    );
    if (!account || account.family !== networkById(this.networkId).family)
      throw new WalletError("ACCOUNT", "Select an account for this network.");
    return account;
  }
  private async maximumAmount(intent: TransactionIntent) {
    this.requireUnlocked();
    await this.assertRevision();
    const account = await this.selectedAccount();
    if (
      intent.accountId !== account.id ||
      intent.networkId !== this.networkId ||
      intent.kind !== "send"
    )
      throw new WalletError(
        "WRONG_NETWORK",
        "Maximum quote account or network differs.",
      );
    const portfolio = await this.refreshPortfolio(),
      balance = portfolio.balances.find(
        (b) => assetKey(b.asset) === assetKey(intent.asset),
      );
    if (!balance || balance.stale || BigInt(balance.available) <= 0n)
      throw new WalletError(
        "BALANCE_UNAVAILABLE",
        "A fresh spendable balance is required.",
      );
    let available = BigInt(balance.available);
    if (intent.asset.standard !== "native") return String(available);
    if (account.family === "bitcoin") {
      const { adapter, watch, watchId, ledgerFingerprint } =
          await this.bitcoinContext(),
        reserved = await this.bitcoinReserved(account.id, ledgerFingerprint),
        state = await adapter.refresh(watch, watchId),
        inputs = state.utxos
          .filter(
            (u) =>
              BigInt(u.confirmations) > 0n &&
              !reserved.has(u.txid + ":" + u.vout),
          )
          .sort((a, b) => (BigInt(a.value) > BigInt(b.value) ? -1 : 1))
          .slice(0, 10),
        destination = validateRegtestAddress(intent.recipient),
        fee =
          (11n +
            BigInt(inputs.length) * (watch.purpose === 84 ? 69n : 58n) +
            BigInt(destination.outputBytes)) *
          BigInt(state.feeRate),
        maximum = inputs.reduce((n, u) => n + BigInt(u.value), 0n) - fee;
      if (maximum < destination.dust)
        throw new WalletError(
          "INSUFFICIENT_FUNDS",
          "No supported maximum remains after fees and dust policy.",
        );
      return String(maximum);
    }
    const probe = {
      ...intent,
      amount: String(
        account.family === "solana"
          ? available > 2000000n
            ? 1000000n
            : available / 2n
          : 1n,
      ),
    };
    const operation =
      account.family === "solana"
        ? await this.solana().prepare(probe, account)
        : await this.evm().prepare(
            probe,
            account,
            await this.evm().provider.getTransactionCount(
              account.address,
              "pending",
            ),
            (await this.evm().environment()).bootEpoch,
          );
    available -= BigInt(operation.fee.maximum);
    if (available <= 0n)
      throw new WalletError(
        "INSUFFICIENT_FUNDS",
        "No amount remains after the complete fee reserve.",
      );
    return String(available);
  }
  private async prepareOperation(intent: TransactionIntent) {
    this.requireUnlocked();
    await this.assertRevision();
    const account = await this.selectedAccount();
    if (intent.accountId !== account.id || intent.networkId !== this.networkId)
      throw new WalletError(
        "WRONG_NETWORK",
        "Intent identity differs from the selected account and network.",
      );
    if (networkById(this.networkId).family === "bitcoin")
      return this.prepareBitcoin(intent);
    if (networkById(this.networkId).family === "solana")
      return this.prepareSolana(intent, account);
    if (intent.kind === "swap") {
      const cached = this.quotes.get(intent.parameters?.quoteId ?? "");
      if (
        !cached ||
        cached.accountId !== account.id ||
        cached.networkId !== this.networkId ||
        cached.quote.expiresAt <= this.clock() ||
        cached.quote.amountIn !== intent.amount
      )
        throw new WalletError(
          "STALE_QUOTE",
          "Request a fresh quote in this wallet before reviewing the swap.",
        );
      const q = cached.quote;
      intent = {
        ...intent,
        parameters: {
          quoteId: q.quoteId,
          minimum: q.minimum,
          output: q.output,
          quoteExpiry: String(q.expiresAt),
          deadline: q.deadline,
          slippageBps: q.slippageBps,
        },
      };
      this.quotes.delete(q.quoteId);
    }
    const adapter = this.evm(),
      environment = await adapter.environment(),
      key = `nonces:${this.networkId}:${account.address}:${environment.bootEpoch ?? "public"}`;
    return this.store.exclusive(key, async () => {
      const nonce = await adapter.provider.getTransactionCount(
        account.address,
        "pending",
      );
      const schema = z.record(
        z.string(),
        z.object({
          nonce: z.number().int().nonnegative(),
          expiresAt: z.number(),
          signed: z.boolean(),
        }),
      );
      const reservations = schema.parse(await this.store.preference(key, {}));
      for (const [id, r] of Object.entries(reservations))
        if (!r.signed && r.expiresAt < this.clock()) delete reservations[id];
      if (Object.keys(reservations).length >= 20)
        throw new WalletError(
          "REQUEST_LIMIT",
          "Resolve pending operations before preparing more.",
        );
      const selectedNonce = Math.max(
        nonce,
        ...Object.values(reservations).map((r) => r.nonce + 1),
      );
      const op = await adapter.prepare(
        intent,
        account,
        selectedNonce,
        environment.bootEpoch,
      );
      const journal = new OperationJournal(this.store);
      const reservedDebits = await this.pendingDebits(
        journal,
        account.id,
        this.networkId,
        environment.bootEpoch,
      );
      const balances = await adapter.balances(account, []);
      // Imported tokens can also be spent; query their validated metadata/balance.
      if (
        !balances.some(
          (b) => assetKey(b.asset) === assetKey(op.intent.asset),
        ) &&
        op.intent.asset.standard === "erc20"
      ) {
        const m = await adapter.tokenMetadata(op.intent.asset.reference);
        balances.push(
          ...(
            await adapter.balances(account, [
              {
                reference: m.address,
                symbol: m.symbol,
                name: m.name,
                decimals: m.decimals,
              },
            ])
          ).filter((b) => assetKey(b.asset) === assetKey(op.intent.asset)),
        );
      }
      for (const [key, raw] of operationDebits(op)) {
        const balance = balances.find((b) => assetKey(b.asset) === key);
        const collectible =
          key === assetKey(op.intent.asset) && op.intent.kind === "nft-transfer"
            ? (await adapter.collectibles(account)).find(
                (c) => assetKey(c.asset) === key,
              )
            : null;
        const total = BigInt(balance?.raw ?? collectible?.quantity ?? "0");
        if (raw + (reservedDebits.get(key) ?? 0n) > total)
          throw new WalletError(
            "RESERVED_FUNDS",
            "Balance is already reserved by another reviewed or pending operation. Resolve it before preparing another.",
          );
      }
      await journal.create(op);
      await journal.transition(op.id, "review_ready", "awaiting_approval");
      await this.store.setPreference(key, {
        ...reservations,
        [op.id]: {
          nonce: selectedNonce,
          expiresAt: op.expiresAt,
          signed: false,
        },
      });
      return this.approvals.register(op);
    });
  }
  private async pendingDebits(
    journal: OperationJournal,
    accountId: string,
    networkId: string,
    epoch: string | null,
  ) {
    const operations: PreparedOperation[] = [];
    for (const entry of await journal.entries()) {
      if (
        entry.operation.intent.accountId !== accountId ||
        entry.operation.intent.networkId !== networkId
      )
        continue;
      if (
        ["review_ready", "awaiting_approval"].includes(entry.state) &&
        entry.operation.expiresAt <= this.clock()
      ) {
        await journal.transition(entry.id, entry.state, "expired");
        continue;
      }
      if (
        ![
          "review_ready",
          "awaiting_approval",
          "signing",
          "signed",
          "submitted",
          "submission_unknown",
          "orphaned",
        ].includes(entry.state)
      )
        continue;
      const payload = z
        .object({ bootEpoch: z.string().nullable() })
        .parse(JSON.parse(entry.operation.encodedPayload));
      if (payload.bootEpoch === epoch) operations.push(entry.operation);
    }
    return sumDebits(operations);
  }
  private async nonceUpdate(
    op: PreparedOperation,
    signed: boolean,
    remove = false,
  ) {
    const account = (await this.store.accounts()).find(
      (a) => a.id === op.intent.accountId,
    );
    if (!account) return;
    const epoch = z
      .object({ bootEpoch: z.string().nullable() })
      .parse(JSON.parse(op.encodedPayload)).bootEpoch;
    const key = `nonces:${op.intent.networkId}:${account.address}:${epoch ?? "public"}`;
    await this.store.exclusive(key, async () => {
      const reservations = await this.store.preference<
        Record<string, { nonce: number; expiresAt: number; signed: boolean }>
      >(key, {});
      if (remove) delete reservations[op.id];
      else if (reservations[op.id]) reservations[op.id].signed = signed;
      await this.store.setPreference(key, reservations);
    });
  }
  private async rejectOperation(id: string) {
    const journal = new OperationJournal(this.store),
      entry = await journal.get(id);
    if (entry && ["review_ready", "awaiting_approval"].includes(entry.state)) {
      await journal.transition(id, entry.state, "rejected");
      if (networkById(entry.operation.intent.networkId).family === "evm")
        await this.nonceUpdate(entry.operation, false, true);
    }
  }
  private record(
    entry: JournalEntry,
    observation?: {
      state: TransactionRecord["state"];
      height: string | null;
      fee: string | null;
    },
  ): TransactionRecord {
    return {
      id: entry.id,
      networkId: entry.operation.intent.networkId,
      hash: entry.expectedIdentifier,
      intent: entry.operation.intent,
      state: observation?.state ?? entry.state,
      height: observation?.height ?? entry.observation?.height ?? null,
      fee: observation?.fee ?? entry.observation?.fee ?? null,
      createdAt: new Date(entry.operation.createdAt).toISOString(),
      replacementId: null,
      reorg: entry.reorged === true || entry.state === "orphaned",
      source: "node",
    };
  }
  private async executeOperation(id: string) {
    if (networkById(this.networkId).family === "bitcoin")
      return this.executeBitcoin(id);
    if (networkById(this.networkId).family === "solana")
      return this.executeSolana(id);
    this.requireUnlocked();
    await this.assertRevision();
    const op = this.approvals.consume(id),
      account = await this.selectedAccount(),
      adapter = this.evm(),
      journal = new OperationJournal(this.store);
    if (
      op.intent.networkId !== this.networkId ||
      op.intent.accountId !== account.id
    )
      throw new WalletError(
        "WRONG_NETWORK",
        "Account or network changed. Review again.",
      );
    await journal.transition(id, "awaiting_approval", "signing");
    let signed: string;
    try {
      const payload = await adapter.revalidate(op, account);
      this.approvals.review(id);
      const secret = this.requireUnlocked();
      await this.assertRevision();
      signed = await signReviewedEvm(
        secret,
        account,
        payload,
        networkById(this.networkId).identity,
      );
    } catch (error) {
      await journal.transition(id, "signing", "rejected");
      await this.nonceUpdate(op, false, true);
      throw error;
    }
    const expected = Transaction.from(signed).hash;
    if (!expected)
      throw new WalletError(
        "SIGNING_FAILED",
        "The signed transaction has no expected identifier.",
      );
    await journal.transition(id, "signing", "signed", {
      expectedIdentifier: expected,
      signedBytesBase64: base64(
        new Uint8Array(
          signed
            .slice(2)
            .match(/../g)!
            .map((b) => parseInt(b, 16)),
        ),
      ),
    });
    await this.nonceUpdate(op, true);
    try {
      await adapter.provider.broadcastTransaction(signed);
      await journal.transition(id, "signed", "submitted");
    } catch {
      await journal.transition(id, "signed", "submission_unknown");
      return this.record((await journal.get(id))!);
    }
    const observation = await adapter.status(expected);
    await journal.observe(id, expected, observation);
    const entry = (await journal.get(id))!;
    if (observation.state === "included" || observation.state === "confirmed") {
      await journal.transition(id, "submitted", "included");
      if (observation.state === "confirmed") {
        await journal.transition(id, "included", "confirmed");
        await this.nonceUpdate(op, true, true);
      }
    } else if (observation.state === "reverted") {
      await journal.transition(id, "submitted", "reverted");
      await this.nonceUpdate(op, true, true);
    }
    return this.record((await journal.get(id)) ?? entry, observation);
  }
  private async indexed(
    account: Awaited<ReturnType<WalletCore["selectedAccount"]>>,
    activity: TransactionRecord[],
    watchId?: string,
  ) {
    try {
      return await readIndexedHistory(
        account,
        this.networkId,
        activity,
        watchId,
      );
    } catch {
      return {
        activity,
        history: {
          status: "unavailable" as const,
          observedAt: null,
          observedHeight: null,
          coverage:
            "Indexed history is unavailable; journal entries remain visible.",
          hasMore: false,
          watchId: watchId ?? "",
        },
      };
    }
  }
  private async refreshPortfolio() {
    if (networkById(this.networkId).family === "bitcoin")
      return this.refreshBitcoin();
    if (networkById(this.networkId).family === "solana")
      return this.refreshSolana();
    this.requireUnlocked();
    await this.assertRevision();
    const account = await this.selectedAccount(),
      adapter = this.evm(),
      custom = await this.store.preference<
        Array<{
          reference: string;
          symbol: string;
          name: string;
          decimals: number;
        }>
      >(`customTokens:${this.networkId}`, []),
      hidden = await this.store.preference<Record<string, boolean>>(
        `hiddenAssets:${this.networkId}`,
        {},
      );
    const balances = (await adapter.balances(account, custom)).map((b) => ({
      ...b,
      hidden: hidden[assetKey(b.asset)] ?? b.hidden,
    }));
    const allowances = await adapter.allowances(account);
    const collectibles = await adapter.collectibles(account),
      journal = new OperationJournal(this.store),
      activity: TransactionRecord[] = [];
    for (let entry of (await journal.entries()).filter(
      (e) =>
        e.operation.intent.accountId === account.id &&
        e.operation.intent.networkId === this.networkId,
    )) {
      if (
        entry.expectedIdentifier &&
        [
          "signed",
          "submitted",
          "submission_unknown",
          "included",
          "confirmed",
          "orphaned",
        ].includes(entry.state)
      ) {
        const payload = z
          .object({ bootEpoch: z.string().nullable() })
          .parse(JSON.parse(entry.operation.encodedPayload));
        if ((await adapter.environment()).bootEpoch !== payload.bootEpoch) {
          activity.push({
            ...this.record(entry),
            state: "orphaned",
            reorg: true,
          });
          continue;
        }
        if (entry.state === "signed") {
          await journal.transition(entry.id, "signed", "submission_unknown");
          entry = (await journal.get(entry.id))!;
        }
        const observed = await adapter.status(entry.expectedIdentifier!);
        await journal.observe(entry.id, entry.expectedIdentifier!, observed);
        if (
          observed.state === "orphaned" &&
          ["included", "confirmed", "submitted", "submission_unknown"].includes(
            entry.state,
          )
        ) {
          await journal.transition(entry.id, entry.state, "orphaned");
          entry = (await journal.get(entry.id))!;
        }
        if (observed.state === "confirmed" || observed.state === "included") {
          if (
            ["submission_unknown", "submitted", "orphaned"].includes(
              entry.state,
            )
          ) {
            await journal.transition(entry.id, entry.state, "included");
            entry = (await journal.get(entry.id))!;
          }
          if (observed.state === "confirmed" && entry.state === "included") {
            await journal.transition(entry.id, "included", "confirmed");
            await this.nonceUpdate(entry.operation, true, true);
          }
        } else if (
          observed.state === "reverted" &&
          ["included", "submitted", "submission_unknown"].includes(entry.state)
        ) {
          await journal.transition(entry.id, entry.state, "reverted");
          await this.nonceUpdate(entry.operation, true, true);
        } else if (
          observed.state === "submitted" &&
          ["confirmed", "included"].includes(entry.state)
        )
          await journal.transition(entry.id, entry.state, "orphaned");
        activity.push(this.record((await journal.get(entry.id))!, observed));
      } else activity.push(this.record(entry));
    }
    const reserved = await this.pendingDebits(
      journal,
      account.id,
      this.networkId,
      (await adapter.environment()).bootEpoch,
    );
    return {
      balances: balances.map((b) => {
        const raw = BigInt(b.raw),
          pending = reserved.get(assetKey(b.asset)) ?? 0n,
          r = pending > raw ? raw : pending;
        return { ...b, reserved: String(r), available: String(raw - r) };
      }),
      collectibles,
      allowances,
      ...(await this.indexed(account, activity)),
      observedAt: balances[0]?.observation.observedAt ?? null,
    };
  }
}
