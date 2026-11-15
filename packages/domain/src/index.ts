export {
  connectorMethods,
  connectorFamily,
  connectorHelloSchema,
  connectorRequestSchema,
  connectorResponseSchema,
  connectorAckSchema,
  assertConnectorOrigin,
  parseConnectorRequest,
  type ConnectorRequest,
  messageReviewSchema,
  type MessageReview,
} from "./connector";
export { solanaManifestSchema } from "./solana-manifest";
import type { ServiceState } from "./services";
export {
  serviceStateSchema,
  swapQuoteSchema,
  type ServiceState,
  type SwapQuote,
} from "./services";
import { z } from "zod";

export const integer = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(100);
export const family = z.enum(["evm", "solana", "bitcoin"]);
export const environment = z.enum(["mock", "local", "testnet"]);
export const networkProfileSchema = z.object({
  id: z.string().max(80),
  name: z.string().max(80),
  family,
  environment,
  identity: z.string().max(128),
  rpcs: z.array(z.url()).max(3),
  feeAsset: z.object({
    symbol: z.string(),
    decimals: z.number().int().min(0).max(36),
  }),
  explorer: z.url().nullable(),
  capabilities: z.array(z.string()),
  finality: z.object({
    confirmations: z.number().int().positive(),
    label: z.string(),
  }),
  rpcTimeoutMs: z.number().int().min(1000).max(30000).default(10000),
  logRangeLimit: z.number().int().positive().default(1000),
  feeMode: z
    .enum(["auto", "eip1559", "legacy", "solana", "utxo"])
    .default("auto"),
  verifiedAt: z.string().nullable().default(null),
  deploymentManifest: z.string().nullable().default(null),
});
export type NetworkProfile = z.infer<typeof networkProfileSchema>;
export const accountRefSchema = z.object({
  id: z.string(),
  rootWalletId: z.string(),
  family,
  address: z.string().max(200),
  path: z.string().max(100),
  index: z.number().int().nonnegative(),
  name: z.string().max(60),
});
export type AccountRef = z.infer<typeof accountRefSchema>;
export const assetIdSchema = z.object({
  networkId: z.string(),
  standard: z.enum([
    "native",
    "erc20",
    "erc721",
    "erc1155",
    "spl",
    "token2022",
    "solana-nft",
  ]),
  reference: z.string().max(200),
  tokenId: integer.optional(),
});
export type AssetId = z.infer<typeof assetIdSchema>;
export function assetKey(a: AssetId) {
  return [a.networkId, a.standard, a.reference, a.tokenId ?? ""].join("/");
}
export const observationSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("fixture"),
    observedHeight: z.string(),
    observedAt: z.iso.datetime(),
  }),
  z.object({
    source: z.literal("node"),
    networkId: z.string(),
    observedHeight: integer,
    observedAt: z.iso.datetime(),
    blockHash: z.string().optional(),
  }),
]);
export const assetBalanceSchema = z
  .object({
    asset: assetIdSchema,
    raw: integer,
    available: integer,
    reserved: integer,
    decimals: z.number().int().min(0).max(36),
    observation: observationSchema,
    symbol: z.string().max(30),
    name: z.string().max(100),
    hidden: z.boolean(),
    verified: z.boolean(),
    microUsdRate: integer.nullable(),
    stale: z.boolean(),
  })
  .superRefine((b, ctx) => {
    if (BigInt(b.available) + BigInt(b.reserved) > BigInt(b.raw))
      ctx.addIssue({
        code: "custom",
        message: "Available and reserved exceed balance",
      });
  });
export type AssetBalance = z.infer<typeof assetBalanceSchema>;
export const portfolioValueSchema = z.object({
  microUsd: integer,
  priceSource: z.literal("demo"),
  rateTimestamp: z.iso.datetime(),
  missingPriceCount: z.number().int().nonnegative(),
});
export type PortfolioValue = z.infer<typeof portfolioValueSchema>;
export const operationKind = z.enum([
  "send",
  "nft-transfer",
  "approve",
  "revoke",
  "swap",
  "bridge",
  "faucet",
  "deposit",
  "withdraw",
  "propose",
  "multisig-approve",
  "multisig-revoke",
  "execute",
]);
export const transactionIntentSchema = z
  .object({
    requestId: z.string().max(80),
    accountId: z.string(),
    networkId: z.string(),
    kind: operationKind,
    recipient: z.string().max(200),
    asset: assetIdSchema,
    amount: integer,
    origin: z.url().optional(),
    parameters: z.record(z.string(), z.string().max(300)).optional(),
  })
  .refine(
    (i) => i.networkId === i.asset.networkId,
    "Asset belongs to a different network",
  );
export type TransactionIntent = z.infer<typeof transactionIntentSchema>;
export const preparedOperationSchema = z.object({
  id: z.string(),
  intent: transactionIntentSchema,
  encodedPayload: z.string().max(100_000),
  preview: z.object({
    title: z.string(),
    recipient: z.string(),
    amount: integer,
    warnings: z.array(z.string()),
    assetSymbol: z.string().max(30).optional(),
    decimals: z.number().int().min(0).max(36).optional(),
    decodedOperation: z.string().max(4000).optional(),
    contractAddress: z.string().optional(),
    nonce: integer.optional(),
    sender: z.string().max(200).optional(),
  }),
  fee: z.object({
    estimated: integer,
    maximum: integer,
    symbol: z.string(),
    decimals: z.number().int(),
  }),
  createdAt: z.number(),
  expiresAt: z.number(),
  fingerprint: z.string(),
  digest: z.string(),
  source: z.enum(["fixture", "node"]),
});
export type PreparedOperation = z.infer<typeof preparedOperationSchema>;
export const approvalRequestSchema = z.object({
  requestId: z.string(),
  sender: z.object({
    origin: z.string(),
    channel: z.string(),
    trusted: z.boolean(),
  }),
  payloadDigest: z.string(),
  accountId: z.string(),
  networkId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export const transactionState = z.enum([
  "draft",
  "review_ready",
  "awaiting_approval",
  "rejected",
  "expired",
  "signing",
  "signed",
  "submitted",
  "submission_unknown",
  "included",
  "confirmed",
  "finalized",
  "reverted",
  "dropped",
  "replaced",
  "orphaned",
]);
export const transactionRecordSchema = z.object({
  id: z.string(),
  networkId: z.string(),
  hash: z.string().nullable(),
  intent: transactionIntentSchema,
  state: transactionState,
  height: integer.nullable(),
  fee: integer.nullable(),
  createdAt: z.iso.datetime(),
  replacementId: z.string().nullable(),
  reorg: z.boolean(),
  source: z.enum(["fixture", "node"]),
  direction: z.enum(["incoming", "outgoing", "self"]).optional(),
});
export type TransactionRecord = z.infer<typeof transactionRecordSchema>;
export const collectibleSchema = z.object({
  id: z.string(),
  asset: assetIdSchema,
  name: z.string(),
  quantity: integer,
  metadataStatus: z.enum(["safe", "missing", "blocked", "unsupported"]),
  transferable: z.boolean().optional(),
  unsupportedReason: z.string().max(300).optional(),
  image: z.string().nullable(),
  owner: z.string(),
  observation: observationSchema,
});
export type Collectible = z.infer<typeof collectibleSchema>;
export const appPermissionSchema = z.object({
  id: z.string(),
  origin: z.url(),
  family,
  networks: z.array(z.string()),
  accounts: z.array(z.string()),
  methods: z.array(z.string()),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revoked: z.boolean(),
});
export type AppPermission = z.infer<typeof appPermissionSchema>;
export const appErrorSchema = z.object({
  code: z.string().max(80),
  message: z.string().max(500),
  retryable: z.boolean(),
  correlationId: z.string(),
});
export type AppError = z.infer<typeof appErrorSchema>;
export class WalletError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
  toJSON(): AppError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      correlationId: crypto.randomUUID(),
    };
  }
}

export function parseAmount(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new WalletError("DECIMALS", "Unsupported asset precision.");
  if (input.length > 100 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(input))
    throw new WalletError(
      "AMOUNT",
      "Enter a positive decimal amount without exponents.",
    );
  const [whole, fraction = ""] = input.split(".");
  if (fraction.length > decimals)
    throw new WalletError(
      "PRECISION",
      `This asset allows ${decimals} decimal places.`,
    );
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}
export function formatAmount(raw: string | bigint, decimals: number): string {
  const n = BigInt(raw);
  if (n < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new WalletError("AMOUNT", "Invalid quantity.");
  if (!decimals) return n.toString();
  const padded = n.toString().padStart(decimals + 1, "0");
  const f = padded.slice(-decimals).replace(/0+$/, "");
  return padded.slice(0, -decimals) + (f ? "." + f : "");
}
export function demoValue(balances: AssetBalance[]): PortfolioValue {
  let microUsd = 0n,
    missingPriceCount = 0;
  for (const b of balances.filter((b) => !b.hidden)) {
    if (b.microUsdRate === null) {
      missingPriceCount++;
      continue;
    }
    microUsd +=
      (BigInt(b.raw) * BigInt(b.microUsdRate)) / 10n ** BigInt(b.decimals);
  }
  return {
    microUsd: microUsd.toString(),
    priceSource: "demo",
    rateTimestamp: "2026-11-13T12:00:00.000Z",
    missingPriceCount,
  };
}
export function formatUsd(micro: string): string {
  const cents = BigInt(micro) / 10_000n;
  return (
    "$" +
    (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    "." +
    (cents % 100n).toString().padStart(2, "0")
  );
}
export const contactSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  networkId: z.string(),
  address: z.string().min(1).max(200),
});
export type Contact = z.infer<typeof contactSchema>;
export type Scenario =
  | "populated"
  | "empty"
  | "loading"
  | "rpc-offline"
  | "stale"
  | "low-fee"
  | "wrong-network"
  | "rejected"
  | "pending"
  | "reverted"
  | "expired-quote";
export type VaultPosition = {
  id: string;
  amount: string;
  unlockAt: number;
  withdrawn: boolean;
};
export type SharedProposal = {
  id: string;
  recipient: string;
  amount: string;
  approvals: string[];
  executed: boolean;
};
export type WalletSnapshot = {
  mode: "mock" | "local" | "testnet";
  source: "fixture" | "node";
  initialized: boolean;
  locked: boolean;
  accounts: AccountRef[];
  selectedAccountId: string;
  networkId: string;
  balances: AssetBalance[];
  activity: TransactionRecord[];
  collectibles: Collectible[];
  permissions: AppPermission[];
  contacts: Contact[];
  positions: VaultPosition[];
  proposals: SharedProposal[];
  scenario: Scenario;
  updatedAt: string;
  hiddenAmounts: boolean;
  autoLockMinutes: 1 | 5 | 15;
  remoteMediaAllowed?: boolean;
  notification?: { key: string; hash: string; state: string };
  history?: {
    status: "ready" | "syncing" | "unavailable";
    observedAt: string | null;
    observedHeight: string | null;
    coverage: string;
    hasMore: boolean;
    watchId: string;
    nextCursor?: string | null;
  };
  bitcoinWatchConsentRequired?: boolean;
  balanceStatus?: "ready" | "loading" | "unavailable" | "stale";
  lastError?: AppError;
  allowances?: Array<{
    id: string;
    asset: AssetId;
    spender: string;
    raw: string;
    symbol: string;
    decimals: number;
  }>;
};
export interface WalletGateway {
  getSnapshot(): WalletSnapshot;
  subscribe(listener: () => void): () => void;
  create(
    password: string,
    confirmation: string,
  ): Promise<{ words: string[]; challenge: number[] }>;
  importSample(
    words: string,
    password: string,
    confirmation: string,
    passphrase?: string,
  ): Promise<void>;
  finishBackup(answers: string[], acknowledged: boolean): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): void;
  changePassword(
    current: string,
    next: string,
    confirmation: string,
  ): Promise<void>;
  revealRecovery(password: string): Promise<string[]>;
  exportPublicData(): string;
  reset(password: string, acknowledged: boolean): Promise<void>;
  selectAccount(id: string): void;
  addAccount(name: string): Promise<void>;
  renameAccount(id: string, name: string): void;
  selectNetwork(id: string): void;
  estimateMaximum?(intent: TransactionIntent): Promise<string>;
  loadOlderActivity?(): Promise<void>;
  refresh(): Promise<void>;
  toggleAmounts(): void;
  setAutoLock(minutes: 1 | 5 | 15): void;
  importToken(
    reference: string,
    symbol: string,
    decimals: number,
  ): Promise<void>;
  hideAsset(key: string, hidden: boolean): void;
  receive(
    type?: "p2wpkh" | "p2tr",
    amount?: string,
  ): { address: string; payload: string };
  saveContact(contact: Contact): void;
  deleteContact(id: string): void;
  prepare(intent: TransactionIntent): Promise<PreparedOperation>;
  approve(id: string, digest: string): Promise<TransactionRecord>;
  reject(id: string): void;
  disconnect(id: string): void;
  quote(
    amount: string,
    slippageBps: string,
  ): Promise<{ output: string; minimum: string; expiresAt: number }>;
  loadServices?(): Promise<ServiceState>;
  setRemoteMediaAllowed?(allowed: boolean): Promise<void>;
  loadCollectibleMetadata?(id: string): Promise<void>;
  connectBitcoinWatch?(): Promise<void>;
  newBitcoinReceive?(): Promise<void>;
  setScenario(scenario: Scenario): void;
}
