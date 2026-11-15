import { z } from "zod";
const raw = z.string().regex(/^(0|[1-9][0-9]*)$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const serviceTokenSchema = z.object({
  reference: address,
  symbol: z.string().max(30),
  decimals: z.number().int().min(0).max(36),
});
export const serviceStateSchema = z.object({
  networkId: z.string(),
  accountAddress: address,
  observedBlock: raw,
  chainTimestamp: raw,
  observedAt: z.iso.datetime(),
  contracts: z.object({
    faucet: address,
    vault: address,
    pool: address,
    shared: address,
    bridge: address,
  }),
  token: serviceTokenSchema,
  outputToken: serviceTokenSchema,
  faucet: z.object({
    amount: raw,
    nextClaimAt: raw,
    claims: raw,
    maximumClaims: raw,
  }),
  allowances: z.object({ vault: raw, pool: raw, bridge: raw }),
  positions: z
    .array(
      z.object({
        id: raw,
        token: serviceTokenSchema,
        amount: raw,
        unlockAt: raw,
        withdrawn: z.boolean(),
      }),
    )
    .max(500),
  shared: z.object({
    owners: z.array(address).length(3),
    nativeBalance: raw,
    tokenBalance: raw,
    proposals: z
      .array(
        z.object({
          id: raw,
          recipient: address,
          amount: raw,
          standard: z.enum(["native", "erc20"]),
          token: serviceTokenSchema.nullable(),
          approvals: z.array(address),
          executed: z.boolean(),
          supported: z.boolean(),
        }),
      )
      .max(500),
  }),
});
export type ServiceState = z.infer<typeof serviceStateSchema>;
export const swapQuoteSchema = z.object({
  quoteId: z.string().uuid(),
  amountIn: raw,
  output: raw,
  minimum: raw,
  expiresAt: z.number().int(),
  deadline: raw,
  slippageBps: raw,
  priceImpactBps: raw,
  allowance: raw,
});
export type SwapQuote = z.infer<typeof swapQuoteSchema>;
