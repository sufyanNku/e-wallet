import {
  indexedNotifications,
  requestAssetMetadata,
} from "@ewallet/config/rpc";
import { z } from "zod";
import {
  accountRefSchema,
  appPermissionSchema,
  connectorRequestSchema,
  messageReviewSchema,
  assetIdSchema,
  serviceStateSchema,
  swapQuoteSchema,
  assetBalanceSchema,
  collectibleSchema,
  transactionRecordSchema,
  preparedOperationSchema,
  contactSchema,
  parseAmount,
  WalletError,
  type WalletGateway,
  type WalletSnapshot,
  type TransactionIntent,
  type PreparedOperation,
  type TransactionRecord,
  type Contact,
} from "@ewallet/domain";
import { coreStatusSchema, type CoreStatus } from "@ewallet/domain/protocol";
import { networkById } from "@ewallet/config";
import { WorkerClient } from "./worker-client";
import { publicStore } from "./public-store";
export class RealWalletGateway implements WalletGateway {
  private listeners = new Set<() => void>();
  private client: WorkerClient;
  private broadcast: BroadcastChannel;
  private touchedAt = 0;
  private bitcoinReceive = new Map<string, string>();
  private historyPages = new Map<string, number>();
  private mediaCache = new Map<
    string,
    {
      name: string | null;
      image: string | null;
      metadataStatus: "safe" | "blocked" | "missing";
    }
  >();
  private state: WalletSnapshot = {
    mode: __WALLET_MODE__ === "testnet" ? "testnet" : "local",
    source: "node",
    initialized: false,
    locked: true,
    accounts: [],
    selectedAccountId: "",
    networkId:
      __WALLET_MODE__ === "testnet" ? "eip155:11155111" : "eip155:31337",
    balances: [],
    balanceStatus: "unavailable",
    activity: [],
    collectibles: [],
    permissions: [],
    contacts: [],
    positions: [],
    proposals: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
    hiddenAmounts: false,
    autoLockMinutes: 5,
  };
  private constructor() {
    this.client = new WorkerClient((reason) => {
      if (
        !this.state.locked ||
        (reason.includes("timeout") && this.state.lastError?.message !== reason)
      )
        this.emit({
          locked: true,
          lastError: new WalletError("LOCKED", reason).toJSON(),
        });
    });
    this.broadcast = new BroadcastChannel(`ewallet-public-${this.state.mode}`);
    this.broadcast.onmessage = (event) => {
      if (event.data?.type === "lock") this.doLock(false);
      if (
        event.data?.type === "selection" &&
        window.location.pathname === "/connect"
      )
        this.doLock(false);
      if (event.data?.type === "permissions")
        void this.syncPermissions().catch((e) => this.report(e));
      if (event.data?.type === "revision")
        void this.sync().catch((e) => this.report(e));
    };
    const touch = () => {
      if (Date.now() - this.touchedAt < 1000) return;
      this.touchedAt = Date.now();
      void this.client
        .request("session.touch", {})
        .catch((e) => this.report(e));
    };
    window.addEventListener("pointerdown", touch, { passive: true });
    window.addEventListener("keydown", touch, { passive: true });
    document.addEventListener("visibilitychange", () => {
      void this.client
        .request("session.visibility", { hidden: document.hidden })
        .then((data) => this.status(data))
        .catch((e) => this.report(e));
    });
    window.addEventListener("pagehide", () => this.client.dispose(), {
      once: true,
    });
  }
  static async open() {
    const gateway = new RealWalletGateway();
    await gateway.sync();
    const storage = await publicStore(
      gateway.state.mode as "local" | "testnet",
    );
    gateway.emit({
      contacts: z.array(contactSchema).parse(await storage.get("contacts")),
      remoteMediaAllowed: await storage.uiPreference(
        "ui:remoteMediaAllowed",
        false,
      ),
    });
    return gateway;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(patch: Partial<WalletSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private status(data: unknown) {
    const s = coreStatusSchema.parse(data);
    this.emit({
      initialized: s.initialized,
      locked: s.locked,
      accounts: s.accounts,
      selectedAccountId: s.selectedAccountId,
      networkId: s.networkId,
      autoLockMinutes: s.autoLockMinutes,
      lastError: undefined,
    });
    return s;
  }
  private async sync() {
    return this.status(await this.client.request("session.status", {}));
  }
  private report(error: unknown) {
    this.emit({
      lastError: (error instanceof WalletError
        ? error
        : new WalletError("WALLET_ERROR", "The wallet request failed.")
      ).toJSON(),
    });
  }
  private revised() {
    this.broadcast.postMessage({ type: "revision" });
  }
  async create(password: string, confirmation: string) {
    const r = z
      .object({
        words: z.array(z.string()).length(24),
        challenge: z.array(z.number().int().min(0).max(23)).length(3),
      })
      .parse(
        await this.client.request("vault.create", {
          password,
          confirmation,
          passphrase: "",
        }),
      );
    return r;
  }
  async finishBackup(answers: string[], acknowledged: boolean) {
    this.status(
      await this.client.request("vault.backupConfirm", {
        answers,
        acknowledged,
      }),
    );
    this.revised();
    void navigator.storage?.persist?.();
  }
  async restorePhrase(
    mnemonic: string,
    password: string,
    confirmation: string,
    passphrase = "",
  ) {
    this.status(
      await this.client.request("vault.import", {
        mnemonic,
        password,
        confirmation,
        passphrase,
      }),
    );
    this.revised();
    void navigator.storage?.persist?.();
  }
  async unlock(password: string) {
    this.status(await this.client.request("vault.unlock", { password }));
  }
  lock() {
    this.doLock(true);
  }
  private doLock(broadcast: boolean) {
    this.emit({ locked: true });
    this.client.restart();
    if (broadcast) this.broadcast.postMessage({ type: "lock" });
    void this.sync().catch((e) => this.report(e));
  }
  async changePassword(current: string, next: string, confirmation: string) {
    this.status(
      await this.client.request("vault.changePassword", {
        current,
        next,
        confirmation,
      }),
    );
    this.revised();
  }
  async revealRecovery(password: string) {
    const r = z
      .object({ words: z.array(z.string()).max(24), expiresAt: z.number() })
      .parse(await this.client.request("vault.revealRecovery", { password }));
    return r.words;
  }
  async exportEncrypted(password: string) {
    return z
      .string()
      .max(65536)
      .parse(await this.client.request("vault.exportEncrypted", { password }));
  }
  async restoreEncrypted(
    envelopeJson: string,
    password: string,
    acknowledged: boolean,
  ) {
    this.status(
      await this.client.request("vault.restoreEncrypted", {
        envelopeJson,
        password,
        acknowledged,
      }),
    );
    this.revised();
  }
  exportPublicData() {
    return JSON.stringify(
      {
        schemaVersion: 1,
        mode: this.state.mode,
        accounts: this.state.accounts,
        contacts: this.state.contacts,
        activity: this.state.activity,
      },
      null,
      2,
    );
  }
  async reset(password: string, acknowledged: boolean) {
    this.status(
      await this.client.request("vault.reset", { password, acknowledged }),
    );
    this.emit({
      balances: [],
      contacts: [],
      activity: [],
      permissions: [],
      allowances: [],
      collectibles: [],
      positions: [],
      proposals: [],
    });
    this.broadcast.postMessage({ type: "lock" });
    this.revised();
  }
  selectAccount(accountId: string) {
    this.broadcast.postMessage({ type: "selection" });
    void this.client
      .request("accounts.select", { accountId })
      .then((data) => {
        this.status(data);
        this.emit({
          balances: [],
          collectibles: [],
          activity: [],
          allowances: [],
          balanceStatus: "unavailable",
        });
      })
      .catch((e) => this.report(e));
  }
  async addAccount(name: string) {
    const f = networkById(this.state.networkId).family;
    const indexes = this.state.accounts
      .filter((a) => a.family === f)
      .map((a) => a.index);
    const index = Math.max(-1, ...indexes) + 1;
    accountRefSchema.parse(
      await this.client.request("accounts.derive", {
        family: f,
        index,
        name: name || `Account ${index + 1}`,
        bitcoinType: "p2wpkh",
        change: 0,
        addressIndex: 0,
      }),
    );
    await this.sync();
    this.revised();
  }
  renameAccount(accountId: string, name: string) {
    void this.client
      .request("accounts.rename", { accountId, name })
      .then((data) => {
        this.status(data);
        this.revised();
      })
      .catch((e) => this.report(e));
  }
  selectNetwork(networkId: string) {
    this.broadcast.postMessage({ type: "selection" });
    void this.client
      .request("network.select", { networkId })
      .then((data) => {
        this.status(data);
        this.emit({
          balances: [],
          balanceStatus: "unavailable",
          collectibles: [],
          activity: [],
          allowances: [],
        });
      })
      .catch((e) => this.report(e));
  }
  async refresh() {
    await this.sync();
    await this.syncPermissions();
    try {
      const result = z
        .object({
          balances: z.array(assetBalanceSchema),
          collectibles: z.array(collectibleSchema),
          activity: z.array(transactionRecordSchema),
          allowances: z.array(
            z.object({
              id: z.string(),
              asset: assetIdSchema,
              spender: z.string(),
              raw: z.string(),
              symbol: z.string(),
              decimals: z.number().int(),
            }),
          ),
          observedAt: z.string().nullable(),
          history: z
            .object({
              status: z.enum(["ready", "syncing", "unavailable"]),
              observedAt: z.string().nullable(),
              observedHeight: z.string().nullable(),
              coverage: z.string(),
              hasMore: z.boolean(),
              watchId: z.string(),
              nextCursor: z.string().nullable().optional(),
            })
            .optional(),
          receiveAddress: z.string().optional(),
        })
        .parse(await this.client.request("portfolio.refresh", {}));
      const pageKey = this.state.selectedAccountId + ":" + this.state.networkId,
        pages = this.historyPages.get(pageKey) ?? 1;
      for (let page = 1; page < pages && result.history?.nextCursor; page++) {
        const older = z
          .object({
            activity: z.array(transactionRecordSchema),
            history: z.object({
              status: z.enum(["ready", "syncing", "unavailable"]),
              observedAt: z.string().nullable(),
              observedHeight: z.string().nullable(),
              coverage: z.string(),
              hasMore: z.boolean(),
              watchId: z.string(),
              nextCursor: z.string().nullable(),
            }),
          })
          .parse(
            await this.client.request("portfolio.historyMore", {
              watchId: result.history.watchId,
              cursor: result.history.nextCursor,
            }),
          );
        const hashes = new Set(
            result.activity
              .filter((t) => !t.id.startsWith("indexed:"))
              .map((t) => t.hash),
          ),
          ids = new Set(result.activity.map((t) => t.id));
        result.activity.push(
          ...older.activity.filter(
            (t) => !hashes.has(t.hash) && !ids.has(t.id),
          ),
        );
        result.history = older.history;
      }
      if (pages >= 10 && result.history?.hasMore)
        result.history = {
          ...result.history,
          hasMore: false,
          coverage:
            result.history.coverage +
            " UI history is bounded to 500 indexed entries; older records remain available through cursor API pagination.",
        };
      if (result.receiveAddress)
        this.bitcoinReceive.set(
          this.state.selectedAccountId,
          result.receiveAddress,
        );
      this.emit({
        balances: result.balances,
        collectibles: result.collectibles.map((c) => {
          const cached = this.mediaCache.get(c.id);
          return cached
            ? {
                ...c,
                name: cached.name ?? c.name,
                image: cached.image,
                metadataStatus: cached.metadataStatus,
              }
            : c;
        }),
        activity: result.activity,
        history: result.history,
        allowances: result.allowances,
        balanceStatus: "ready",
        bitcoinWatchConsentRequired: false,
        updatedAt: result.observedAt ?? this.state.updatedAt,
        lastError: undefined,
      });
      if (result.history?.watchId) {
        try {
          const notifications = z
            .object({
              notifications: z.array(
                z.object({
                  networkId: z.string(),
                  hash: z.string(),
                  state: z.string(),
                }),
              ),
            })
            .parse(await indexedNotifications(result.history.watchId));
          const latest = notifications.notifications[0];
          if (latest)
            this.emit({
              notification: {
                key: latest.networkId + ":" + latest.hash + ":" + latest.state,
                hash: latest.hash,
                state: latest.state,
              },
            });
        } catch {
          /* Notifications do not block current balances. */
        }
      }
    } catch (error) {
      this.emit({
        balanceStatus: this.state.balances.length ? "stale" : "unavailable",
        bitcoinWatchConsentRequired:
          error instanceof WalletError && error.code === "WATCH_CONSENT",
        balances: this.state.balances.map((b) => ({ ...b, stale: true })),
      });
      this.report(error);
      throw error;
    }
  }
  toggleAmounts() {
    this.emit({ hiddenAmounts: !this.state.hiddenAmounts });
  }
  setAutoLock(autoLockMinutes: 1 | 5 | 15) {
    void this.client
      .request("session.settings", { autoLockMinutes })
      .then((data) => this.status(data))
      .catch((e) => this.report(e));
  }
  async importToken(
    _reference: string,
    _symbol: string,
    _decimals: number,
  ): Promise<void> {
    await this.client.request("assets.import", {
      reference: _reference,
      symbol: _symbol,
      decimals: _decimals,
    });
    await this.refresh();
  }
  hideAsset(_key: string, _hidden: boolean) {
    void this.client
      .request("assets.hide", { key: _key, hidden: _hidden })
      .then(() => this.refresh())
      .catch((e) => this.report(e));
  }
  async estimateMaximum(intent: TransactionIntent) {
    return z
      .string()
      .regex(/^[0-9]+$/)
      .parse(await this.client.request("operation.max", intent));
  }
  async loadOlderActivity() {
    const pageKey = this.state.selectedAccountId + ":" + this.state.networkId;
    if ((this.historyPages.get(pageKey) ?? 1) >= 10) return;
    const history = this.state.history;
    if (!history?.nextCursor) return;
    const accountId = this.state.selectedAccountId,
      networkId = this.state.networkId,
      result = z
        .object({
          activity: z.array(transactionRecordSchema),
          history: z.object({
            status: z.enum(["ready", "syncing", "unavailable"]),
            observedAt: z.string().nullable(),
            observedHeight: z.string().nullable(),
            coverage: z.string(),
            hasMore: z.boolean(),
            watchId: z.string(),
            nextCursor: z.string().nullable(),
          }),
        })
        .parse(
          await this.client.request("portfolio.historyMore", {
            watchId: history.watchId,
            cursor: history.nextCursor,
          }),
        );
    if (
      this.state.selectedAccountId !== accountId ||
      this.state.networkId !== networkId ||
      this.state.locked
    )
      return;
    this.historyPages.set(pageKey, (this.historyPages.get(pageKey) ?? 1) + 1);
    const existing = new Map(this.state.activity.map((t) => [t.id, t]));
    for (const record of result.activity)
      if (
        !this.state.activity.some(
          (t) => !t.id.startsWith("indexed:") && t.hash === record.hash,
        )
      )
        existing.set(record.id, record);
    this.emit({
      activity: Array.from(existing.values()).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
      history: result.history,
    });
  }
  async connectBitcoinWatch() {
    await this.client.request("bitcoin.watch", { acknowledged: true });
    await this.refresh();
  }
  async newBitcoinReceive() {
    const result = z
      .object({ address: z.string() })
      .parse(await this.client.request("bitcoin.receive", {}));
    this.bitcoinReceive.set(this.state.selectedAccountId, result.address);
    this.emit({ updatedAt: new Date().toISOString() });
  }
  receive(type: "p2wpkh" | "p2tr" = "p2wpkh", amount?: string) {
    const selected = this.state.accounts.find(
      (a) => a.id === this.state.selectedAccountId,
    );
    let account = selected;
    if (selected?.family === "bitcoin")
      account = this.state.accounts.find(
        (a) =>
          a.index === selected.index &&
          a.family === "bitcoin" &&
          a.path.startsWith(type === "p2tr" ? "m/86'" : "m/84'"),
      );
    if (!account)
      throw new WalletError(
        "ACCOUNT",
        "Derive the selected address type before receiving.",
      );
    const n = networkById(this.state.networkId);
    if (amount) parseAmount(amount, n.feeAsset.decimals);
    const address =
      account.family === "bitcoin"
        ? (this.bitcoinReceive.get(account.id) ?? account.address)
        : account.address;
    return {
      address,
      payload: JSON.stringify({
        network: n.id,
        address,
        ...(amount ? { amount } : {}),
      }),
    };
  }
  saveContact(input: Contact) {
    const contact = contactSchema.parse(input),
      contacts = [
        ...this.state.contacts.filter((c) => c.id !== contact.id),
        contact,
      ];
    void publicStore(this.state.mode as "local" | "testnet")
      .then((store) => store.replace("contacts", contacts))
      .then(() => this.emit({ contacts }))
      .catch((e) => this.report(e));
  }
  deleteContact(id: string) {
    const contacts = this.state.contacts.filter((c) => c.id !== id);
    void publicStore(this.state.mode as "local" | "testnet")
      .then((store) => store.replace("contacts", contacts))
      .then(() => this.emit({ contacts }))
      .catch((e) => this.report(e));
  }
  async prepare(intent: TransactionIntent): Promise<PreparedOperation> {
    return preparedOperationSchema.parse(
      await this.client.request("operation.prepare", intent),
    );
  }
  async approve(id: string, digest: string): Promise<TransactionRecord> {
    await this.client.request("operation.approve", { operationId: id, digest });
    const record = transactionRecordSchema.parse(
      await this.client.request("operation.execute", { operationId: id }),
    );
    this.emit({
      activity: [
        record,
        ...this.state.activity.filter((t) => t.id !== record.id),
      ],
    });
    void this.refresh().catch((e) => this.report(e));
    return record;
  }
  reject(operationId: string) {
    void this.client
      .request("operation.reject", { operationId })
      .catch((e) => this.report(e));
  }
  disconnect(id: string) {
    void this.client
      .request("permissions.revoke", { id })
      .then(() => this.syncPermissions())
      .then(() => this.broadcast.postMessage({ type: "permissions" }))
      .catch((e) => this.report(e));
  }
  async pollConnector() {
    await this.sync();
    await this.syncPermissions();
  }
  async selectConnectorAccount(accountId: string) {
    this.status(await this.client.request("accounts.select", { accountId }));
  }
  async selectConnectorNetwork(networkId: string) {
    this.status(await this.client.request("network.select", { networkId }));
  }
  switchConnector(channel: string) {
    return this.client.request("dapp.switch", { channel });
  }
  async openConnector(origin: string, request: unknown) {
    return this.client.request("dapp.open", {
      origin,
      request: connectorRequestSchema.parse(request),
    });
  }
  async grantConnector(channel: string) {
    const grant = appPermissionSchema.parse(
      await this.client.request("dapp.grant", { channel }),
    );
    this.emit({
      permissions: [
        grant,
        ...this.state.permissions.filter((p) => p.id !== grant.id),
      ],
    });
    this.broadcast.postMessage({ type: "permissions" });
    return grant;
  }
  readConnector(channel: string) {
    return this.client.request("dapp.read", { channel });
  }
  async disconnectConnector(channel: string) {
    const result = await this.client.request("dapp.disconnect", { channel });
    await this.syncPermissions();
    this.broadcast.postMessage({ type: "permissions" });
    return result;
  }
  async prepareConnector(channel: string) {
    return z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("transaction"),
          operation: preparedOperationSchema,
        }),
        z.object({ kind: z.literal("message"), review: messageReviewSchema }),
      ])
      .parse(await this.client.request("dapp.prepare", { channel }));
  }
  executeConnector(channel: string, operationId: string, digest: string) {
    return this.client.request("dapp.execute", {
      channel,
      operationId,
      digest,
    });
  }
  signConnectorMessage(channel: string, messageId: string, digest: string) {
    return this.client.request("dapp.signMessage", {
      channel,
      messageId,
      digest,
    });
  }
  private async syncPermissions() {
    this.emit({
      permissions: z
        .array(appPermissionSchema)
        .parse(await this.client.request("permissions.list", {})),
    });
  }
  async setRemoteMediaAllowed(allowed: boolean) {
    const storage = await publicStore(this.state.mode as "local" | "testnet");
    await storage.setUiPreference("ui:remoteMediaAllowed", allowed);
    this.emit({ remoteMediaAllowed: allowed });
  }
  async loadCollectibleMetadata(id: string) {
    const collectible = this.state.collectibles.find((c) => c.id === id);
    if (!collectible)
      throw new WalletError("COLLECTIBLE", "Collectible not found.");
    const response = z
      .object({
        assetKey: z.string(),
        name: z.string().nullable(),
        image: z
          .string()
          .regex(/^\/api\/v1\/media\/[0-9a-f]{64}$/)
          .nullable(),
        status: z.enum(["safe", "blocked", "missing"]),
        imageStatus: z.string(),
      })
      .parse(
        await requestAssetMetadata(id, this.state.remoteMediaAllowed === true),
      );
    if (response.assetKey !== id)
      throw new WalletError("METADATA", "Metadata identity differs.");
    this.mediaCache.set(id, {
      name: response.name,
      image: response.image,
      metadataStatus: response.status,
    });
    this.emit({
      collectibles: this.state.collectibles.map((c) =>
        c.id === id
          ? {
              ...c,
              name: response.name ?? c.name,
              image: response.image,
              metadataStatus: response.status,
            }
          : c,
      ),
    });
  }
  async loadServices() {
    return serviceStateSchema.parse(
      await this.client.request("services.state", {}),
    );
  }
  async quote(amount: string, slippageBps: string) {
    return swapQuoteSchema.parse(
      await this.client.request("services.quote", {
        amount: parseAmount(amount, 6).toString(),
        slippageBps,
      }),
    );
  }
  async discover(family: CoreStatus["accounts"][number]["family"], start = 0) {
    const result = await this.client.request("accounts.discovery", {
      family,
      start,
      count: 20,
    });
    await this.sync();
    this.revised();
    return result;
  }
}
