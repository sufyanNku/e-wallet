import { z } from "zod";
import {
  transactionRecordSchema,
  assetIdSchema,
  transactionState,
  type AccountRef,
  type TransactionRecord,
} from "@ewallet/domain";
import type { NativeApi } from "./api";
const responseSchema = z.object({
  watchId: z.string().uuid(),
  networkId: z.string(),
  address: z.string(),
  status: z.enum(["ready", "syncing", "unavailable"]),
  coverage: z.string(),
  nextCursor: z.string().nullable(),
  records: z
    .array(
      z.object({
        networkId: z.string(),
        hash: z.string(),
        height: z.string().nullable(),
        state: transactionState,
        fee: z.string().nullable(),
        createdAt: z.string(),
        canonical: z.boolean(),
        eventIndex: z.string(),
        amount: z.string(),
        recipient: z.string().nullable(),
        standard: assetIdSchema.shape.standard,
        reference: z.string(),
        tokenId: z.string(),
        direction: z.enum(["incoming", "outgoing", "self"]),
      }),
    )
    .max(50),
});
export async function nativeHistory(
  api: NativeApi,
  account: AccountRef,
  networkId: string,
  journal: TransactionRecord[],
  watchId?: string,
  cursor = "0",
) {
  const watch = watchId
    ? { watchId }
    : await api.request<{ watchId: string }>("/api/v1/watch", "POST", {
        networkId,
        address: account.address,
        backfillAcknowledged: true,
        startHeight: "0",
      });
  const result = responseSchema.parse(
    await api.request(
      "/api/v1/activity?" +
        new URLSearchParams({ watchId: watch.watchId, cursor, limit: "50" }),
    ),
  );
  if (
    result.watchId !== watch.watchId ||
    result.networkId !== networkId ||
    result.address.toLowerCase() !== account.address.toLowerCase()
  )
    throw new Error("History watch identity mismatch");
  const existing = new Set(journal.map((t) => t.hash)),
    indexed = result.records
      .filter((r) => !existing.has(r.hash))
      .map((r) =>
        transactionRecordSchema.parse({
          id: `indexed:${r.hash}:${r.eventIndex}`,
          networkId,
          hash: r.hash,
          intent: {
            requestId: "idx:" + r.hash.slice(-64),
            accountId: account.id,
            networkId,
            kind: ["erc721", "erc1155", "solana-nft"].includes(r.standard)
              ? "nft-transfer"
              : "send",
            recipient: r.recipient ?? "Unknown counterparty",
            asset: {
              networkId,
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
        }),
      );
  return {
    activity: [...journal, ...indexed].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
    history: {
      watchId: result.watchId,
      nextCursor: result.nextCursor,
      status: result.status,
      coverage: result.coverage,
    },
  };
}
