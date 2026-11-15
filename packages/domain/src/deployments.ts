import { z } from "zod";
import { integer } from "./index";
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const deploymentSchema = z.object({
  schemaVersion: z.literal(1),
  networkId: z.string(),
  chainId: integer,
  genesisHash: hash,
  bootEpoch: z.string(),
  runId: z.string(),
  createdAt: z.iso.datetime(),
  compiler: z.object({ version: z.string(), evmVersion: z.literal("paris") }),
  deploymentBlock: integer,
  contracts: z.record(
    z.string(),
    z.object({
      address,
      codeHash: hash,
      transactionHash: hash,
      abiHash: hash,
      blockNumber: integer,
      constructorArguments: z.array(z.unknown()),
    }),
  ),
  assets: z.array(
    z.object({
      symbol: z.string().max(30),
      name: z.string().max(100),
      standard: z.enum(["erc20", "erc721", "erc1155"]),
      reference: address,
      decimals: z.number().int().min(0).max(36),
      tokenIds: z.array(integer).optional(),
      hidden: z.boolean().default(false),
    }),
  ),
});
export type DeploymentManifest = z.infer<typeof deploymentSchema>;
