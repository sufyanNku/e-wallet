import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseAmount } from "@ewallet/domain";
const quoteSchema = z.object({
  data: z.object({
    amount: z
      .string()
      .regex(/^[0-9]+(?:\.[0-9]{1,18})?$/)
      .max(80),
    currency: z.literal("USD"),
  }),
});
export type MarketSnapshot = {
  assets: Array<{ symbol: string; name: string; microUsd: string }>;
  observedAt: string | null;
  source: "Coinbase spot";
  stale: boolean;
  purpose: "Market reference only; test assets have no monetary value";
};
export function marketReader(
  transport: typeof fetch = fetch,
  clock = Date.now,
) {
  let cached: MarketSnapshot | null = null,
    expires = 0,
    inflight: Promise<MarketSnapshot> | null = null;
  return async (): Promise<MarketSnapshot> => {
    if (cached && clock() < expires) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      const results = await Promise.allSettled(
        (
          [
            ["BTC", "Bitcoin"],
            ["ETH", "Ethereum"],
            ["SOL", "Solana"],
          ] as const
        ).map(async ([symbol, name]) => {
          const response = await transport(
            `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`,
            {
              redirect: "error",
              signal: AbortSignal.timeout(6000),
              headers: { Accept: "application/json" },
            },
          );
          if (
            !response.ok ||
            Number(response.headers.get("content-length") ?? "0") > 16384
          )
            throw new Error("Market provider unavailable");
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Missing response");
          let size = 0;
          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 16384) throw new Error("Quote response too large");
              chunks.push(value);
            }
          } finally {
            await reader.cancel();
          }
          const joined = new Uint8Array(size);
          let offset = 0;
          for (const c of chunks) {
            joined.set(c, offset);
            offset += c.length;
          }
          const body = quoteSchema.parse(
              JSON.parse(new TextDecoder().decode(joined)),
            ),
            scaled = parseAmount(body.data.amount, 18) / 1000000000000n;
          if (scaled <= 0n) throw new Error("Invalid quote");
          return { symbol, name, microUsd: String(scaled) };
        }),
      );
      const assets = results.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : [],
      );
      if (assets.length) {
        cached = {
          assets,
          observedAt: new Date(clock()).toISOString(),
          source: "Coinbase spot",
          stale: assets.length !== 3,
          purpose: "Market reference only; test assets have no monetary value",
        };
        expires = clock() + 60000;
      } else {
        cached = {
          assets: cached?.assets ?? [],
          observedAt: cached?.observedAt ?? null,
          source: "Coinbase spot",
          stale: true,
          purpose: "Market reference only; test assets have no monetary value",
        };
        expires = clock() + 30000;
      }
      return cached;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
export function registerMarkets(app: FastifyInstance) {
  const read = marketReader();
  app.get(
    "/api/v1/markets",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute", groupId: "markets" },
      },
    },
    async (_req, reply) => {
      reply.header("Cache-Control", "no-store");
      return { data: await read() };
    },
  );
}
