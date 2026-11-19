import {
  assetKey,
  parseAmount,
  transactionIntentSchema,
  WalletError,
  type WalletGateway,
  type WalletSnapshot,
  type TransactionIntent,
  type PreparedOperation,
  type TransactionRecord,
  type AssetBalance,
  type Scenario,
  type Contact,
} from "@ewallet/domain";
import { networkById } from "@ewallet/config";
import { validateRecipient } from "./recipient";

// Deliberately invalid mnemonic; no key derivation exists in the mock bundle.
export const sampleWords = Array.from(
  { length: 24 },
  (_, i) => `sample${String(i + 1).padStart(2, "0")}`,
);
const alice = "0x1111111111111111111111111111111111111111";
export const bob = "0x2222222222222222222222222222222222222222";
const observedAt = "2026-11-13T12:00:00.000Z";
const obs = { source: "fixture" as const, observedHeight: "42", observedAt };
const uid = () => crypto.randomUUID();
function fail(code: string, message: string): never {
  throw new WalletError(code, message);
}
export class MockWalletGateway implements WalletGateway {
  private listeners = new Set<() => void>();
  private pending = new Map<string, PreparedOperation>();
  private consumed = new Set<string>();
  private submitted = new Map<string, PreparedOperation>();
  private challenge: number[] = [];
  private cooldown = 0;
  private cache = new Map<string, AssetBalance[]>();
  private state: WalletSnapshot = {
    mode: "mock",
    source: "fixture",
    initialized: false,
    locked: true,
    accounts: [],
    selectedAccountId: "evm-0",
    networkId: "eip155:31337",
    balances: [],
    activity: [],
    collectibles: [],
    permissions: [],
    contacts: [],
    positions: [],
    proposals: [],
    scenario: "populated",
    updatedAt: observedAt,
    hiddenAmounts: false,
    autoLockMinutes: 5,
  };
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit(patch: Partial<WalletSnapshot> = {}) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private requireUnlocked() {
    if (this.state.locked)
      fail("LOCKED", "Unlock your wallet to continue.");
  }
  private checkPassword(password: string, confirmation?: string) {
    if (
      new TextEncoder().encode(password).length > 1024 ||
      password.length < 12
    )
      fail(
        "PASSWORD",
        "Use at least 12 characters and at most 1,024 UTF-8 bytes.",
      );
    if (confirmation !== undefined && password !== confirmation)
      fail("PASSWORD", "Passwords do not match.");
  }
  private populate() {
    const accounts = [
      {
        id: "evm-0",
        rootWalletId: "sample",
        family: "evm" as const,
        address: alice,
        path: "m/44'/60'/0'/0/0",
        index: 0,
        name: "Everyday",
      },
      {
        id: "solana-0",
        rootWalletId: "sample",
        family: "solana" as const,
        address: "11111111111111111111111111111111",
        path: "m/44'/501'/0'/0'",
        index: 0,
        name: "Everyday",
      },
      {
        id: "bitcoin-0",
        rootWalletId: "sample",
        family: "bitcoin" as const,
        address: "bcrt1qsampleonly00000000000000000000000000",
        path: "m/84'/1'/0'/0/0",
        index: 0,
        name: "Everyday",
      },
    ];
    this.emit({
      initialized: true,
      locked: false,
      accounts,
      contacts: [
        {
          id: "bob",
          name: "Bob",
          networkId: "eip155:31337",
          address: bob,
        },
      ],
      positions: [
        {
          id: "position-1",
          amount: "100000000",
          unlockAt: Date.now() + 3_600_000,
          withdrawn: false,
        },
        {
          id: "position-2",
          amount: "100000000",
          unlockAt: Date.now() - 1000,
          withdrawn: false,
        },
      ],
      proposals: [
        {
          id: "proposal-1",
          recipient: bob,
          amount: "50000000",
          approvals: ["Alice"],
          executed: false,
        },
        {
          id: "proposal-2",
          recipient: bob,
          amount: "25000000",
          approvals: ["Alice", "Bob"],
          executed: false,
        },
      ],
      permissions: [
        {
          id: "sample-app",
          origin: "http://127.0.0.1:5174",
          family: "evm",
          networks: ["eip155:31337"],
          accounts: ["evm-0"],
          methods: ["eth_accounts", "eth_sendTransaction"],
          createdAt: observedAt,
          expiresAt: "2099-11-14T12:00:00.000Z",
          revoked: false,
        },
      ],
    });
    this.loadHoldings();
  }
  loadSample() {
    this.populate();
  }
  async create(password: string, confirmation: string) {
    this.checkPassword(password, confirmation);
    this.challenge = Array.from(
      crypto.getRandomValues(new Uint32Array(3)),
      (n, i) => i * 8 + (n % 8),
    );
    return { words: [...sampleWords], challenge: [...this.challenge] };
  }
  async finishBackup(answers: string[], acknowledged: boolean) {
    if (
      !acknowledged ||
      this.challenge.length !== 3 ||
      answers.some((a, i) => a !== sampleWords[this.challenge[i]])
    )
      fail(
        "BACKUP",
        "Acknowledge your backup and enter the three requested words.",
      );
    this.challenge = [];
    this.populate();
  }
  async importSample(
    words: string,
    password: string,
    confirmation: string,
    _passphrase?: string,
  ) {
    this.checkPassword(password, confirmation);
    if (words.trim().split(/\s+/).join(" ") !== sampleWords.join(" "))
      fail(
        "MNEMONIC",
        "These recovery words are not supported. Check the 24 words and try again.",
      );
    this.populate();
  }
  async unlock(password: string) {
    this.checkPassword(password);
    if (!this.state.initialized)
      fail("NO_WALLET", "Create or import your wallet first.");
    this.emit({ locked: false });
  }
  lock() {
    this.pending.clear();
    this.emit({ locked: true });
  }
  async changePassword(current: string, next: string, confirmation: string) {
    this.requireUnlocked();
    this.checkPassword(current);
    this.checkPassword(next, confirmation);
  }
  async revealRecovery(password: string) {
    this.requireUnlocked();
    this.checkPassword(password);
    return [...sampleWords];
  }
  exportPublicData() {
    return JSON.stringify(
      {
        mode: "mock",
        source: "fixture",
        accounts: this.state.accounts,
        contacts: this.state.contacts,
        activity: this.state.activity,
      },
      null,
      2,
    );
  }
  async reset(password: string, acknowledged: boolean) {
    this.checkPassword(password);
    if (!acknowledged)
      fail(
        "ACKNOWLEDGEMENT",
        "Confirm that you have backed up your wallet.",
      );
    this.cache.clear();
    this.pending.clear();
    this.consumed.clear();
    this.emit({
      initialized: false,
      locked: true,
      accounts: [],
      balances: [],
      activity: [],
      collectibles: [],
      permissions: [],
      positions: [],
      proposals: [],
      contacts: [],
    });
  }
  selectAccount(id: string) {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) fail("ACCOUNT", "Unknown account.");
    if (account.family !== networkById(this.state.networkId).family)
      fail("ACCOUNT", "Select a matching network family first.");
    this.emit({ selectedAccountId: id });
    this.loadHoldings();
  }
  async addAccount(name: string) {
    this.requireUnlocked();
    const f = networkById(this.state.networkId).family;
    const index = this.state.accounts.filter((a) => a.family === f).length;
    const base = this.state.accounts.find((a) => a.family === f)!;
    this.emit({
      accounts: [
        ...this.state.accounts,
        {
          ...base,
          id: `${f}-${index}`,
          index,
          name: name.slice(0, 60) || `Account ${index + 1}`,
          address:
            f === "evm"
              ? `0x${String(index + 3)
                  .repeat(40)
                  .slice(0, 40)}`
              : base.address,
          path:
            f === "evm"
              ? `m/44'/60'/0'/0/${index}`
              : f === "solana"
                ? `m/44'/501'/${index}'/0'`
                : `m/84'/1'/${index}'/0/0`,
        },
      ],
    });
  }
  renameAccount(id: string, name: string) {
    if (!name.trim()) fail("NAME", "Enter an account name.");
    this.emit({
      accounts: this.state.accounts.map((a) =>
        a.id === id ? { ...a, name: name.slice(0, 60) } : a,
      ),
    });
  }
  selectNetwork(id: string) {
    const n = networkById(id);
    const account = this.state.accounts.find((a) => a.family === n.family);
    this.emit({ networkId: id, selectedAccountId: account?.id ?? "" });
    this.loadHoldings();
  }
  private loadHoldings() {
    const n = networkById(this.state.networkId),
      net = n.id,
      dec = n.feeAsset.decimals;
    const native: AssetBalance = {
      asset: { networkId: net, standard: "native", reference: "native" },
      raw: (100n * 10n ** BigInt(dec)).toString(),
      available: (100n * 10n ** BigInt(dec)).toString(),
      reserved: "0",
      decimals: dec,
      observation: obs,
      symbol: n.feeAsset.symbol,
      name: n.name,
      hidden: false,
      verified: true,
      microUsdRate:
        n.family === "bitcoin"
          ? "40000000000"
          : n.family === "solana"
            ? "100000000"
            : "2000000000",
      stale: false,
    };
    let balances: AssetBalance[] = [native];
    if (n.family !== "bitcoin")
      balances.push(
        ...[
          {
            symbol: "dUSDC",
            name: "USD Coin",
            decimals: 6,
            raw: "10000000000",
            ref: "0x3333333333333333333333333333333333333333",
            rate: "1000000",
            hidden: false,
          },
          {
            symbol: "dDAI",
            name: "Dai",
            decimals: 18,
            raw: "10000000000000000000000",
            ref: "0xabababababababababababababababababababab",
            rate: "1000000",
            hidden: false,
          },
          {
            symbol: "EWLT",
            name: "e-wallet Token",
            decimals: 18,
            raw: "2500000000000000000000",
            ref: "0x4444444444444444444444444444444444444444",
            rate: "100000",
            hidden: false,
          },
          {
            symbol: "USDC",
            name: "Unverified token",
            decimals: 6,
            raw: "7000000",
            ref: "0x5555555555555555555555555555555555555555",
            rate: null,
            hidden: true,
          },
        ].map((t) => ({
          ...native,
          asset: {
            networkId: net,
            standard:
              n.family === "evm" ? ("erc20" as const) : ("spl" as const),
            reference: n.family === "evm" ? t.ref : `SampleMint${t.symbol}`,
          },
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          raw: t.raw,
          available: t.raw,
          hidden: t.hidden,
          verified: !t.hidden,
          microUsdRate: t.rate,
        })),
      );
    const key = `${this.state.selectedAccountId}:${net}`;
    balances = this.cache.get(key) ?? balances;
    if (this.state.scenario === "empty") balances = [];
    if (this.state.scenario === "stale")
      balances = balances.map((b) => ({ ...b, stale: true }));
    if (this.state.scenario === "low-fee")
      balances = balances.map((b) =>
        b.asset.standard === "native" ? { ...b, raw: "0", available: "0" } : b,
      );
    this.emit({
      balances,
      collectibles:
        n.family === "bitcoin"
          ? []
          : [
              {
                id: `${net}-campus`,
                asset: {
                  networkId: net,
                  standard: n.family === "evm" ? "erc721" : "solana-nft",
                  reference:
                    n.family === "evm"
                      ? "0x6666666666666666666666666666666666666666"
                      : "SampleCampusMint",
                  tokenId: "101",
                },
                name: "Campus Pass #101",
                quantity: "1",
                metadataStatus: "safe",
                image: "/media/campus.png",
                owner: this.state.selectedAccountId,
                observation: obs,
              },
              {
                id: `${net}-study`,
                asset: {
                  networkId: net,
                  standard: n.family === "evm" ? "erc1155" : "solana-nft",
                  reference:
                    n.family === "evm"
                      ? "0x7777777777777777777777777777777777777777"
                      : "SampleStudyMint",
                  tokenId: "1",
                },
                name: "Study Club",
                quantity: "5",
                metadataStatus: "missing",
                image: null,
                owner: this.state.selectedAccountId,
                observation: obs,
              },
            ],
    });
  }
  private setBalances(balances: AssetBalance[]) {
    this.cache.set(
      `${this.state.selectedAccountId}:${this.state.networkId}`,
      balances,
    );
    this.emit({ balances });
  }
  async refresh() {
    if (this.state.scenario === "rpc-offline")
      fail(
        "RPC_UNAVAILABLE",
        "The network is disconnected. Retry your connection.",
      );
    if (this.state.scenario === "loading") return;
    for (const [id, op] of this.submitted) {
      if (
        op.intent.networkId !== this.state.networkId ||
        op.intent.accountId !== this.state.selectedAccountId
      )
        continue;
      this.setBalances(
        this.state.balances.map((b) => {
          const delta =
            (["send", "deposit", "swap", "bridge"].includes(op.intent.kind) &&
            assetKey(b.asset) === assetKey(op.intent.asset)
              ? BigInt(op.intent.amount)
              : 0n) +
            (b.asset.standard === "native" ? BigInt(op.fee.estimated) : 0n);
          return {
            ...b,
            reserved: (BigInt(b.reserved) - delta).toString(),
            available: (BigInt(b.available) + delta).toString(),
          };
        }),
      );
      this.apply(op);
      this.submitted.delete(id);
      this.emit({
        activity: this.state.activity.map((t) =>
          t.id === id ? { ...t, state: "confirmed" as const, height: "43" } : t,
        ),
      });
    }
    this.emit({
      balances: this.state.balances.map((b) => ({ ...b, stale: false })),
      updatedAt: new Date().toISOString(),
    });
  }
  toggleAmounts() {
    this.emit({ hiddenAmounts: !this.state.hiddenAmounts });
  }
  setAutoLock(minutes: 1 | 5 | 15) {
    this.emit({ autoLockMinutes: minutes });
  }
  async importToken(reference: string, symbol: string, decimals: number) {
    this.requireUnlocked();
    validateRecipient(reference, this.state.networkId);
    if (networkById(this.state.networkId).family === "bitcoin")
      fail("UNSUPPORTED", "Bitcoin supports native BTC only.");
    if (
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 36 ||
      !symbol.trim() ||
      symbol.length > 30
    )
      fail("METADATA", "Review a symbol and supported precision (0–36).");
    const asset = {
      networkId: this.state.networkId,
      standard:
        networkById(this.state.networkId).family === "evm"
          ? ("erc20" as const)
          : ("spl" as const),
      reference: reference.toLowerCase(),
    };
    if (this.state.balances.some((b) => assetKey(b.asset) === assetKey(asset)))
      fail("DUPLICATE", "This token is already imported.");
    this.setBalances([
      ...this.state.balances,
      {
        asset,
        raw: "0",
        available: "0",
        reserved: "0",
        decimals,
        observation: obs,
        symbol,
        name: symbol + " · custom token",
        hidden: false,
        verified: false,
        microUsdRate: null,
        stale: false,
      },
    ]);
  }
  hideAsset(key: string, hidden: boolean) {
    this.setBalances(
      this.state.balances.map((b) =>
        assetKey(b.asset) === key ? { ...b, hidden } : b,
      ),
    );
  }
  receive(type: "p2wpkh" | "p2tr" = "p2wpkh", amount?: string) {
    const account = this.state.accounts.find(
      (a) => a.id === this.state.selectedAccountId,
    );
    if (!account) fail("ACCOUNT", "Select an account first.");
    if (amount)
      parseAmount(amount, networkById(this.state.networkId).feeAsset.decimals);
    const address =
      account.family === "bitcoin"
        ? type === "p2tr"
          ? "bcrt1psampleonly00000000000000000000000000"
          : account.address
        : account.address;
    const payload = JSON.stringify({
      source: "fixture",
      network: this.state.networkId,
      address,
      ...(amount ? { amount } : {}),
    });
    return { address, payload };
  }
  saveContact(contact: Contact) {
    validateRecipient(contact.address, contact.networkId);
    if (!contact.name.trim()) fail("CONTACT", "Enter a contact label.");
    this.emit({
      contacts: [
        ...this.state.contacts.filter((c) => c.id !== contact.id),
        { ...contact, name: contact.name.slice(0, 60) },
      ],
    });
  }
  deleteContact(id: string) {
    this.emit({ contacts: this.state.contacts.filter((c) => c.id !== id) });
  }
  async prepare(input: TransactionIntent) {
    this.requireUnlocked();
    const intent = transactionIntentSchema.parse(structuredClone(input));
    const s = this.state;
    if (s.scenario === "rpc-offline")
      fail("RPC_UNAVAILABLE", "RPC unavailable. No operation has been signed.");
    if (
      s.scenario === "wrong-network" ||
      intent.networkId !== s.networkId ||
      intent.accountId !== s.selectedAccountId
    )
      fail("WRONG_NETWORK", "Account or network changed. Review again.");
    if (["send", "nft-transfer", "propose"].includes(intent.kind))
      validateRecipient(intent.recipient, intent.networkId);
    if (BigInt(intent.amount) <= 0n)
      fail("AMOUNT", "Enter an amount greater than zero.");
    const asset = s.balances.find(
      (b) => assetKey(b.asset) === assetKey(intent.asset),
    );
    const spends = ["send", "deposit", "swap", "bridge"].includes(intent.kind);
    if (spends && (!asset || BigInt(intent.amount) > BigInt(asset.available)))
      fail("INSUFFICIENT_FUNDS", "Amount exceeds your available balance.");
    const n = networkById(s.networkId),
      fee = 10n ** BigInt(Math.max(0, n.feeAsset.decimals - 4));
    const native = s.balances.find((b) => b.asset.standard === "native");
    if (
      !native ||
      BigInt(native.available) <
        fee +
          (spends && intent.asset.standard === "native"
            ? BigInt(intent.amount)
            : 0n)
    )
      fail("LOW_FEE", "Keep enough native currency for the network fee.");
    if (intent.kind === "faucet" && Date.now() < this.cooldown)
      fail(
        "COOLDOWN",
        `Faucet cooldown: ${Math.ceil((this.cooldown - Date.now()) / 1000)} seconds remaining.`,
      );
    if (intent.kind === "nft-transfer") {
      const c = s.collectibles.find(
        (c) => assetKey(c.asset) === assetKey(intent.asset),
      );
      if (!c || BigInt(intent.amount) > BigInt(c.quantity))
        fail("OWNERSHIP", "Quantity exceeds current ownership.");
    }
    if (intent.kind === "withdraw") {
      const p = s.positions.find((p) => p.id === intent.parameters?.positionId);
      if (!p || p.withdrawn || p.unlockAt > Date.now())
        fail(
          "LOCKED_POSITION",
          "This position is still locked or already withdrawn.",
        );
    }
    if (intent.kind === "execute") {
      const p = s.proposals.find((p) => p.id === intent.parameters?.proposalId);
      if (!p || p.executed || p.approvals.length < 2)
        fail(
          "THRESHOLD",
          "Execution requires two distinct owner approvals.",
        );
    }
    if (
      intent.kind === "swap" &&
      (s.scenario === "expired-quote" ||
        Number(intent.parameters?.quoteExpiry ?? 0) < Date.now())
    )
      fail("STALE_QUOTE", "Quote expired. Get a fresh quote and review again.");
    const now = Date.now(),
      payload = JSON.stringify(intent);
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(payload),
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const op: PreparedOperation = {
      id: uid(),
      intent,
      encodedPayload: payload,
      preview: {
        title: intent.kind.replaceAll("-", " "),
        recipient: intent.recipient,
        amount: intent.amount,
        warnings: [
          "Review the recipient and amount before continuing.",
          ...(intent.recipient ===
          this.state.accounts.find((a) => a.id === s.selectedAccountId)?.address
            ? ["You are sending to your own address."]
            : []),
        ],
      },
      fee: {
        estimated: fee.toString(),
        maximum: ((fee * 12n) / 10n).toString(),
        symbol: n.feeAsset.symbol,
        decimals: n.feeAsset.decimals,
      },
      createdAt: now,
      expiresAt: now + 60_000,
      fingerprint: `${s.networkId}:${s.selectedAccountId}`,
      digest,
      source: "fixture",
    };
    this.pending.set(op.id, structuredClone(op));
    return structuredClone(op);
  }
  async approve(id: string, digest: string) {
    this.requireUnlocked();
    const op = this.pending.get(id);
    if (!op || this.consumed.has(id))
      fail("APPROVAL_USED", "This approval was consumed or cancelled.");
    if (op.digest !== digest)
      fail("DIGEST", "The operation changed. Prepare a new review.");
    if (Date.now() > op.expiresAt) {
      this.pending.delete(id);
      fail("EXPIRED", "Review expired. Prepare the operation again.");
    }
    if (
      op.fingerprint !==
      `${this.state.networkId}:${this.state.selectedAccountId}`
    )
      fail("WRONG_NETWORK", "Your account or network changed. Review again.");
    const spending = ["send", "deposit", "swap", "bridge"].includes(
      op.intent.kind,
    );
    const current = this.state.balances.find(
      (b) => assetKey(b.asset) === assetKey(op.intent.asset),
    );
    const feeBalance = this.state.balances.find(
      (b) => b.asset.standard === "native",
    );
    if (
      spending &&
      (!current || BigInt(current.available) < BigInt(op.intent.amount))
    )
      fail("INSUFFICIENT_FUNDS", "Balance changed. Prepare a new review.");
    if (
      !feeBalance ||
      BigInt(feeBalance.available) <
        BigInt(op.fee.estimated) +
          (spending && op.intent.asset.standard === "native"
            ? BigInt(op.intent.amount)
            : 0n)
    )
      fail("LOW_FEE", "Fee balance changed. Prepare a new review.");
    this.consumed.add(id);
    this.pending.delete(id);
    if (this.state.scenario === "rejected")
      fail("USER_REJECTED", "The approval was rejected.");
    const state =
      this.state.scenario === "pending"
        ? "submitted"
        : this.state.scenario === "reverted"
          ? "reverted"
          : "confirmed";
    const record: TransactionRecord = {
      id: uid(),
      networkId: op.intent.networkId,
      hash: `fixture-${uid()}`,
      intent: op.intent,
      state,
      height: state === "submitted" ? null : "43",
      fee: op.fee.estimated,
      createdAt: new Date().toISOString(),
      replacementId: null,
      reorg: false,
      source: "fixture",
    };
    if (state === "confirmed") this.apply(op);
    if (state === "submitted") {
      this.submitted.set(record.id, op);
      this.setBalances(
        this.state.balances.map((b) => {
          const delta =
            (["send", "deposit", "swap", "bridge"].includes(op.intent.kind) &&
            assetKey(b.asset) === assetKey(op.intent.asset)
              ? BigInt(op.intent.amount)
              : 0n) +
            (b.asset.standard === "native" ? BigInt(op.fee.estimated) : 0n);
          return {
            ...b,
            available: (BigInt(b.available) - delta).toString(),
            reserved: (BigInt(b.reserved) + delta).toString(),
          };
        }),
      );
    }
    this.emit({ activity: [record, ...this.state.activity] });
    return record;
  }
  private apply(op: PreparedOperation) {
    const i = op.intent,
      amount = BigInt(i.amount);
    const debit = ["send", "deposit", "swap", "bridge"].includes(i.kind);
    this.setBalances(
      this.state.balances.map((b) => {
        let delta = 0n;
        if (debit && assetKey(b.asset) === assetKey(i.asset)) delta -= amount;
        if (b.asset.standard === "native") delta -= BigInt(op.fee.estimated);
        if (i.kind === "faucet" && b.symbol === "dUSDC") delta += 100000000n;
        if (i.kind === "withdraw" && b.symbol === "dUSDC") delta += amount;
        if (i.kind === "swap" && b.symbol === "dDAI")
          delta += BigInt(i.parameters?.output ?? "0");
        return {
          ...b,
          raw: (BigInt(b.raw) + delta).toString(),
          available: (BigInt(b.available) + delta).toString(),
        };
      }),
    );
    if (i.kind === "faucet") this.cooldown = Date.now() + 60_000;
    if (i.kind === "deposit")
      this.emit({
        positions: [
          ...this.state.positions,
          {
            id: uid(),
            amount: i.amount,
            unlockAt: Date.now() + Number(i.parameters?.duration ?? 60) * 1000,
            withdrawn: false,
          },
        ],
      });
    if (i.kind === "withdraw")
      this.emit({
        positions: this.state.positions.map((p) =>
          p.id === i.parameters?.positionId ? { ...p, withdrawn: true } : p,
        ),
      });
    if (i.kind === "nft-transfer")
      this.emit({
        collectibles: this.state.collectibles.flatMap((c) =>
          assetKey(c.asset) !== assetKey(i.asset)
            ? [c]
            : BigInt(c.quantity) > amount
              ? [{ ...c, quantity: (BigInt(c.quantity) - amount).toString() }]
              : [],
        ),
      });
    if (i.kind === "propose")
      this.emit({
        proposals: [
          ...this.state.proposals,
          {
            id: uid(),
            recipient: i.recipient,
            amount: i.amount,
            approvals: ["Alice"],
            executed: false,
          },
        ],
      });
    if (["multisig-approve", "multisig-revoke", "execute"].includes(i.kind))
      this.emit({
        proposals: this.state.proposals.map((p) =>
          p.id === i.parameters?.proposalId
            ? {
                ...p,
                executed: i.kind === "execute" || p.executed,
                approvals:
                  i.kind === "multisig-approve"
                    ? Array.from(
                        new Set([
                          ...p.approvals,
                          i.parameters?.owner ?? "Alice",
                        ]),
                      )
                    : i.kind === "multisig-revoke"
                      ? p.approvals.filter(
                          (a) => a !== (i.parameters?.owner ?? "Alice"),
                        )
                      : p.approvals,
              }
            : p,
        ),
      });
  }
  reject(id: string) {
    this.pending.delete(id);
  }
  disconnect(id: string) {
    this.emit({
      permissions: this.state.permissions.map((p) =>
        p.id === id ? { ...p, revoked: true } : p,
      ),
    });
  }
  async quote(amount: string, slippageBps: string) {
    const input = parseAmount(amount, 6);
    if (input <= 0n) fail("AMOUNT", "Enter an amount greater than zero.");
    if (!/^\d+$/.test(slippageBps) || BigInt(slippageBps) > 500n)
      fail("SLIPPAGE", "Slippage must be between 0 and 5%.");
    const x = input * 997n,
      output = (x * 1000000n * 10n ** 18n) / (1000000n * 10n ** 6n * 1000n + x);
    return {
      output: output.toString(),
      minimum: ((output * (10000n - BigInt(slippageBps))) / 10000n).toString(),
      expiresAt:
        this.state.scenario === "expired-quote"
          ? Date.now() - 1
          : Date.now() + 30_000,
    };
  }
  setScenario(scenario: Scenario) {
    this.cache.clear();
    this.emit({ scenario });
    this.loadHoldings();
  }
}
