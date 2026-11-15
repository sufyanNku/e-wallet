import { withRpcSlot } from "./rpc-concurrency";
import { parse as parseLossless, isLosslessNumber } from "lossless-json";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { networkById } from "@ewallet/config";
const evmMethods = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_getCode",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_sendRawTransaction",
]);
const solanaMethods = new Set([
  "getGenesisHash",
  "getHealth",
  "getVersion",
  "getSlot",
  "getBlock",
  "getLatestBlockhash",
  "isBlockhashValid",
  "getBlockHeight",
  "getBalance",
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenAccountsByOwner",
  "getTokenAccountBalance",
  "getTokenSupply",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "getTransaction",
  "getSignaturesForAddress",
]);
const bitcoinMethods = new Set([
  "getblockchaininfo",
  "getblockcount",
  "getblockhash",
  "getblockheader",
  "getrawtransaction",
  "gettxout",
  "getmempoolentry",
  "estimatesmartfee",
  "testmempoolaccept",
  "sendrawtransaction",
  "decoderawtransaction",
  "decodepsbt",
]);
const requestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().max(80), z.number().int().safe()]),
    method: z.string().max(80),
    params: z.array(z.unknown()).max(16).default([]),
  })
  .strict();
export async function rpcUpstream(
  url: string,
  method: string,
  params: unknown[],
  authorization?: string,
  exactNumbers = false,
): Promise<unknown> {
  return withRpcSlot(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty RPC response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("RPC response exceeds size limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const source = new TextDecoder().decode(bytes);
    if (!exactNumbers) return JSON.parse(source);
    // Solana u64 and Bitcoin decimal amounts must never pass through a JS float.
    const normalize = (value: unknown): unknown => {
      if (isLosslessNumber(value)) return value.value;
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, v]) => [key, normalize(v)]),
        );
      return value;
    };
    return normalize(parseLossless(source));
  });
}
export function validateRpc(
  method: string,
  params: unknown[],
  family: "evm" | "solana" | "bitcoin",
  logLimit = 1000,
) {
  if (
    !(
      family === "evm"
        ? evmMethods
        : family === "solana"
          ? solanaMethods
          : bitcoinMethods
    ).has(method)
  )
    throw new Error("Unsupported RPC method");
  if (family === "evm") {
    if (method === "eth_getLogs") {
      const filter = z
        .object({
          fromBlock: z.string().regex(/^0x[0-9a-f]+$/i),
          toBlock: z.string().regex(/^0x[0-9a-f]+$/i),
          address: z.union([z.string(), z.array(z.string()).max(20)]),
          topics: z.array(z.unknown()).max(4).optional(),
        })
        .strict()
        .parse(params[0]);
      const range = BigInt(filter.toBlock) - BigInt(filter.fromBlock);
      if (range < 0n || range >= BigInt(logLimit))
        throw new Error("Log range exceeds network policy");
    }
    if (method === "eth_call" || method === "eth_estimateGas") {
      const tx = z
        .object({
          from: z
            .string()
            .regex(/^0x[0-9a-f]{40}$/i)
            .optional(),
          to: z.string().regex(/^0x[0-9a-f]{40}$/i),
          data: z
            .string()
            .regex(/^0x[0-9a-f]*$/i)
            .max(100000)
            .optional(),
          value: z
            .string()
            .regex(/^0x[0-9a-f]+$/i)
            .optional(),
          gas: z.string().optional(),
          gasPrice: z.string().optional(),
          maxFeePerGas: z.string().optional(),
          maxPriorityFeePerGas: z.string().optional(),
          nonce: z.string().optional(),
          type: z.string().optional(),
          chainId: z
            .string()
            .regex(/^0x[0-9a-f]+$/i)
            .optional(),
        })
        .strict()
        .parse(params[0]);
      if (tx.gas && BigInt(tx.gas) > 10000000n)
        throw new Error("Gas bound exceeds policy");
      if (params.length > 2) throw new Error("State overrides are unsupported");
    }
    if (
      method === "eth_feeHistory" &&
      (!params[0] || BigInt(params[0] as string) > 100n)
    )
      throw new Error("Fee history exceeds policy");
    if (
      method === "eth_sendRawTransaction" &&
      (params.length !== 1 ||
        typeof params[0] !== "string" ||
        !/^0x[0-9a-f]+$/i.test(params[0]) ||
        params[0].length > 200000)
    )
      throw new Error("Invalid signed transaction size");
  }
  if (
    family === "solana" &&
    method === "getMultipleAccounts" &&
    (!Array.isArray(params[0]) || params[0].length > 100)
  )
    throw new Error("Account batch exceeds policy");
  if (
    family === "bitcoin" &&
    [
      "testmempoolaccept",
      "sendrawtransaction",
      "decoderawtransaction",
      "decodepsbt",
    ].includes(method) &&
    JSON.stringify(params).length > 200000
  )
    throw new Error("Bitcoin payload exceeds policy");
}
export async function registerRpc(app: FastifyInstance) {
  app.post(
    "/api/v1/rpc/:network",
    {
      config: {
        rateLimit: { max: 2400, timeWindow: "1 minute", groupId: "node-rpc" },
      },
    },
    async (req, reply) => {
      try {
        const networkId = z
            .string()
            .max(80)
            .parse((req.params as { network: string }).network),
          network = networkById(networkId),
          body = requestSchema.parse(req.body);
        validateRpc(
          body.method,
          body.params,
          network.family,
          network.id === "eip155:998" ? 50 : 1000,
        );
        let endpoint =
            network.id === "solana:local" &&
            process.env.EWALLET_ISOLATED_SOLANA_TEST === "1"
              ? "http://127.0.0.1:18899"
              : network.rpcs[0],
          authorization: string | undefined;
        if (network.family === "bitcoin") {
          endpoint =
            process.env.EWALLET_ISOLATED_BITCOIN_TEST === "1"
              ? "http://127.0.0.1:18444"
              : "http://127.0.0.1:18443";
          authorization =
            "Basic " +
            Buffer.from(
              (
                await readFile(
                  process.env.EWALLET_ISOLATED_BITCOIN_TEST === "1"
                    ? ".local/secrets/bitcoin-browser/auth.cookie"
                    : ".local/secrets/bitcoin/auth.cookie",
                  "utf8",
                )
              ).trim(),
            ).toString("base64");
        }
        const raw = (await rpcUpstream(
          endpoint,
          body.method,
          body.params,
          authorization,
          network.family !== "evm",
        )) as { result?: unknown; error?: { code: number; data?: unknown } };
        const data = raw.error
          ? {
              jsonrpc: "2.0",
              id: body.id,
              error: {
                code: Number(raw.error.code),
                message: "RPC execution failed",
                ...(typeof raw.error.data === "string" &&
                raw.error.data.length < 65536
                  ? { data: raw.error.data }
                  : {}),
              },
            }
          : { jsonrpc: "2.0", id: body.id, result: raw.result };
        reply.header("Cache-Control", "no-store");
        return {
          data,
          meta: {
            networkId,
            source: "node",
            observedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        const invalid =
          error instanceof z.ZodError ||
          (error instanceof Error &&
            /Unsupported|Invalid|exceeds|overrides|policy/.test(error.message));
        return reply.code(invalid ? 400 : 503).send({
          error: {
            code: invalid ? "RPC_POLICY" : "RPC_UNAVAILABLE",
            message: invalid
              ? "This RPC request is outside the supported policy."
              : "The selected network is unavailable.",
            correlationId: req.id,
          },
        });
      }
    },
  );
}
