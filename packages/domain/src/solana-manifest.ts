import { z } from "zod";
const publicKey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  raw = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const solanaManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    seedVersion: z.literal(1),
    networkId: z.literal("solana:local"),
    genesisHash: publicKey,
    observedAt: z.iso.datetime(),
    metadataProgram: z
      .object({
        programId: z.literal("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
        programSha256: z.string().regex(/^[0-9a-f]{64}$/),
        loadedExecutable: z.literal(true),
      })
      .passthrough(),
    mints: z.record(
      z.string().max(40),
      z.object({
        address: publicKey,
        decimals: z.number().int().min(0).max(36),
        program: publicKey,
        name: z.string().max(100),
        symbol: z.string().max(30),
      }),
    ),
    stages: z.record(
      z.string().max(100),
      z.object({
        signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
        lastValidBlockHeight: raw,
        state: z.enum(["signed", "confirmed"]),
        fee: raw.nullable().optional(),
        historyAvailability: z.enum(["live", "pruned"]).optional(),
      }),
    ),
    finalBalances: z.array(
      z.object({
        name: z.string(),
        address: publicKey,
        sol: raw,
        tokens: z.record(z.string(), raw),
      }),
    ),
  })
  .passthrough();
