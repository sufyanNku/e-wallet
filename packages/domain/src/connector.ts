import { z } from "zod";
export const connectorFamily = z.enum(["evm", "solana", "bitcoin"]);
export const connectorMethods = {
  evm: [
    "eth_requestAccounts",
    "eth_accounts",
    "eth_chainId",
    "wallet_switchEthereumChain",
    "eth_sendTransaction",
    "personal_sign",
    "eth_signTypedData_v4",
  ],
  solana: [
    "solana:connect",
    "solana:accounts",
    "solana:signMessage",
    "solana:signTransaction",
    "solana:signAndSendTransaction",
  ],
  bitcoin: [
    "bitcoin:getAccounts",
    "bitcoin:getNetwork",
    "bitcoin:signPsbt",
    "bitcoin:broadcastTransaction",
  ],
} as const;
const base = {
  version: z.literal(1),
  channel: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid(),
};
export const connectorHelloSchema = z
  .object({
    ...base,
    type: z.literal("ewallet:hello"),
    expiresAt: z.number().int(),
  })
  .strict();
export const connectorRequestSchema = z
  .object({
    ...base,
    type: z.literal("ewallet:request"),
    family: connectorFamily,
    method: z.string().min(1).max(80),
    params: z.array(z.unknown()).max(10),
    expiresAt: z.number().int(),
  })
  .strict();
export type ConnectorRequest = z.infer<typeof connectorRequestSchema>;
export const connectorResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("ewallet:event"),
      event: z.enum(["accountsChanged", "chainChanged", "disconnect"]),
      accounts: z.array(z.string()).optional(),
      networkId: z.string().optional(),
    })
    .strict(),
  z.object({ ...base, type: z.literal("ewallet:ready") }).strict(),
  z
    .object({ ...base, type: z.literal("ewallet:result"), result: z.unknown() })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("ewallet:error"),
      error: z
        .object({ code: z.number().int(), message: z.string().max(500) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("ewallet:verify"),
      challenge: z.string().uuid(),
    })
    .strict(),
]);
export const connectorAckSchema = z
  .object({
    ...base,
    type: z.literal("ewallet:verifyAck"),
    challenge: z.string().uuid(),
  })
  .strict();
export function assertConnectorOrigin(origin: string) {
  if (origin === "null" || origin.length > 200)
    throw new Error("Opaque or oversized origins are denied.");
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw new Error(
      "Only HTTPS sites or explicit local development origins can connect.",
    );
  return origin;
}
export function parseConnectorRequest(input: unknown) {
  const serialized = JSON.stringify(input);
  if (!serialized || new TextEncoder().encode(serialized).length > 131072)
    throw new Error("Connector request exceeds 128 KiB.");
  const request = connectorRequestSchema.parse(input);
  if (
    !(connectorMethods[request.family] as readonly string[]).includes(
      request.method,
    ) &&
    request.method !== "disconnect"
  )
    throw new Error("Unsupported connector method.");
  return request;
}
export const messageReviewSchema = z
  .object({
    id: z.string().uuid(),
    channel: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.url().max(200),
    accountAddress: z.string().max(100),
    networkId: z.string().max(80),
    method: z.enum([
      "personal_sign",
      "eth_signTypedData_v4",
      "solana:signMessage",
    ]),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int(),
    displayText: z.string().max(70000),
    encoding: z.enum(["utf8", "hex", "eip712"]),
    byteLength: z.number().int().min(0).max(16384),
    domain: z
      .object({
        name: z.string().nullable(),
        version: z.string().nullable(),
        chainId: z.string().nullable(),
        verifyingContract: z.string().nullable(),
      })
      .nullable(),
  })
  .strict();
export type MessageReview = z.infer<typeof messageReviewSchema>;
