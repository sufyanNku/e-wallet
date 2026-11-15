import { z } from "zod";
import { registerAddressWatch, indexedActivity } from "@ewallet/config/rpc";
import {
  transactionState,
  assetIdSchema,
  type AccountRef,
  type TransactionRecord,
} from "@ewallet/domain";
const raw = z.string().regex(/^[0-9]+$/);
const responseSchema = z.object({
  watchId: z.string().uuid(),
  networkId: z.string(),
  status: z.enum(["ready", "syncing", "unavailable"]),
  address: z.string(),
  fingerprint: z.string().nullable(),
  observedHeight: raw.nullable(),
  observedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  coverage: z.string(),
  nextCursor: z.string().nullable(),
  records: z.array(
    z.object({
      networkId: z.string(),
      hash: z.string(),
      height: raw.nullable(),
      blockHash: z.string().nullable(),
      state: transactionState,
      fee: raw.nullable(),
      createdAt: z.string(),
      canonical: z.boolean(),
      eventIndex: z.string(),
      amount: raw,
      sender: z.string().nullable(),
      recipient: z.string().nullable(),
      standard: assetIdSchema.shape.standard,
      reference: z.string(),
      tokenId: z.string(),
      decimals: z.number().int().min(0).max(36),
      symbol: z.string(),
      name: z.string(),
      direction: z.enum(["incoming", "outgoing", "self"]),
    }),
  ),
});
export async function readIndexedHistory(
  account: AccountRef,
  networkId: string,
  journal: TransactionRecord[],
  knownWatchId?: string,
  cursor?: string,
) {
  const registration = knownWatchId
    ? { watchId: knownWatchId }
    : z
        .object({ watchId: z.string().uuid() })
        .parse(await registerAddressWatch(networkId, account.address));
  const result = responseSchema.parse(
      await indexedActivity(registration.watchId, cursor),
    ),
    sameAddress =
      account.family === "evm"
        ? result.address.toLowerCase() === account.address.toLowerCase()
        : result.address === account.address;
  if (
    result.networkId !== networkId ||
    result.watchId !== registration.watchId ||
    !sameAddress
  )
    throw new Error("Indexed watch identity mismatch");
  const existing = new Set(journal.map((t) => t.hash)),
    records: TransactionRecord[] = result.records
      .filter((r) => !existing.has(r.hash))
      .map((r) => ({
        id: `indexed:${r.networkId}:${r.hash}:${r.eventIndex}`,
        networkId: r.networkId,
        hash: r.hash,
        intent: {
          requestId: "idx:" + r.hash.slice(-64),
          accountId: account.id,
          networkId: r.networkId,
          kind: ["erc721", "erc1155", "solana-nft"].includes(r.standard)
            ? "nft-transfer"
            : "send",
          recipient: r.recipient ?? "Unknown counterparty",
          asset: {
            networkId: r.networkId,
            standard: r.standard,
            reference: r.reference,
            ...(r.tokenId ? { tokenId: r.tokenId } : {}),
          },
          amount: r.amount,
        },
        state: r.canonical ? r.state : "orphaned",
        height: r.height,
        fee: r.fee,
        createdAt: r.createdAt,
        replacementId: null,
        reorg: !r.canonical,
        source: "node",
        direction: r.direction,
      }));
  return {
    activity: [...journal, ...records].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
    history: {
      status: result.status,
      observedAt: result.observedAt,
      observedHeight: result.observedHeight,
      coverage: result.coverage,
      hasMore: result.nextCursor !== null,
      watchId: result.watchId,
      nextCursor: result.nextCursor,
    },
  };
}
