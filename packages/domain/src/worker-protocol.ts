import { z } from "zod";
import {
  family,
  transactionIntentSchema,
  accountRefSchema,
  connectorRequestSchema,
} from "./index";
export const coreStatusSchema = z.object({
  initialized: z.boolean(),
  locked: z.boolean(),
  accounts: z.array(accountRefSchema),
  selectedAccountId: z.string(),
  networkId: z.string(),
  autoLockMinutes: z.union([z.literal(1), z.literal(5), z.literal(15)]),
  lockReason: z.string(),
  mode: z.enum(["local", "testnet"]),
  revision: z.number().nullable(),
});
export type CoreStatus = z.infer<typeof coreStatusSchema>;
const password = z
  .string()
  .min(12)
  .max(1024)
  .refine(
    (p) => new TextEncoder().encode(p).length <= 1024,
    "Password exceeds 1,024 UTF-8 bytes",
  );
const envelopeString = z.string().max(65536);
const empty = z.object({}).strict();
function message<M extends string, T extends z.ZodType>(method: M, payload: T) {
  return z
    .object({
      protocolVersion: z.literal(1),
      id: z.string().uuid(),
      method: z.literal(method),
      payload,
    })
    .strict();
}
export const workerRequestSchema = z.discriminatedUnion("method", [
  message("session.status", empty),
  message(
    "portfolio.historyMore",
    z
      .object({ watchId: z.string().uuid(), cursor: z.string().max(1024) })
      .strict(),
  ),
  message("permissions.list", empty),
  message("permissions.revoke", z.object({ id: z.string().uuid() }).strict()),
  message(
    "dapp.open",
    z
      .object({ origin: z.string().max(200), request: connectorRequestSchema })
      .strict(),
  ),
  message(
    "dapp.grant",
    z.object({ channel: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ),
  message(
    "dapp.switch",
    z.object({ channel: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ),
  message(
    "dapp.read",
    z.object({ channel: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ),
  message(
    "dapp.disconnect",
    z.object({ channel: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ),
  message(
    "dapp.signMessage",
    z
      .object({
        channel: z.string().regex(/^[a-f0-9]{64}$/),
        messageId: z.string().uuid(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  ),
  message(
    "dapp.prepare",
    z.object({ channel: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ),
  message(
    "dapp.execute",
    z
      .object({
        channel: z.string().regex(/^[a-f0-9]{64}$/),
        operationId: z.string().uuid(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  ),
  message("session.touch", empty),
  message("session.visibility", z.object({ hidden: z.boolean() }).strict()),
  message(
    "session.settings",
    z
      .object({
        autoLockMinutes: z.union([z.literal(1), z.literal(5), z.literal(15)]),
      })
      .strict(),
  ),
  message(
    "vault.create",
    z
      .object({
        password,
        confirmation: password,
        passphrase: z.string().max(1024).default(""),
      })
      .strict(),
  ),
  message(
    "vault.backupConfirm",
    z
      .object({
        answers: z.array(z.string().max(30)).length(3),
        acknowledged: z.boolean(),
      })
      .strict(),
  ),
  message(
    "vault.import",
    z
      .object({
        mnemonic: z.string().max(2048),
        password,
        confirmation: password,
        passphrase: z.string().max(1024).default(""),
      })
      .strict(),
  ),
  message("vault.unlock", z.object({ password }).strict()),
  message(
    "vault.lock",
    z.object({ reason: z.string().max(100).default("Explicit lock") }).strict(),
  ),
  message(
    "vault.changePassword",
    z
      .object({ current: password, next: password, confirmation: password })
      .strict(),
  ),
  message("vault.revealRecovery", z.object({ password }).strict()),
  message("vault.exportEncrypted", z.object({ password }).strict()),
  message(
    "vault.restoreEncrypted",
    z
      .object({
        envelopeJson: envelopeString,
        password,
        acknowledged: z.boolean(),
      })
      .strict(),
  ),
  message(
    "vault.reset",
    z.object({ password, acknowledged: z.boolean() }).strict(),
  ),
  message("accounts.list", empty),
  message("portfolio.refresh", empty),
  message(
    "bitcoin.watch",
    z.object({ acknowledged: z.literal(true) }).strict(),
  ),
  message("bitcoin.receive", empty),
  message("services.state", empty),
  message(
    "services.quote",
    z
      .object({
        amount: z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .max(78),
        slippageBps: z.string().regex(/^[0-9]{1,3}$/),
      })
      .strict(),
  ),
  message(
    "assets.import",
    z
      .object({
        reference: z.string().max(200),
        symbol: z.string().min(1).max(30),
        decimals: z.number().int().min(0).max(36),
      })
      .strict(),
  ),
  message(
    "assets.hide",
    z.object({ key: z.string().max(500), hidden: z.boolean() }).strict(),
  ),
  message(
    "accounts.select",
    z.object({ accountId: z.string().max(100) }).strict(),
  ),
  message(
    "accounts.rename",
    z
      .object({
        accountId: z.string().max(100),
        name: z.string().min(1).max(60),
      })
      .strict(),
  ),
  message(
    "accounts.derive",
    z
      .object({
        family,
        index: z.number().int().min(0).max(999),
        bitcoinType: z.enum(["p2wpkh", "p2tr"]).default("p2wpkh"),
        change: z.union([z.literal(0), z.literal(1)]).default(0),
        addressIndex: z.number().int().min(0).max(10000).default(0),
        name: z.string().min(1).max(60),
      })
      .strict(),
  ),
  message(
    "accounts.discovery",
    z
      .object({
        family,
        start: z.number().int().min(0).max(980),
        count: z.number().int().min(1).max(20),
      })
      .strict(),
  ),
  message(
    "network.select",
    z.object({ networkId: z.string().max(80) }).strict(),
  ),
  message("operation.prepare", transactionIntentSchema),
  message("operation.max", transactionIntentSchema),
  message(
    "operation.review",
    z.object({ operationId: z.string().uuid() }).strict(),
  ),
  message(
    "operation.approve",
    z
      .object({
        operationId: z.string().uuid(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  ),
  message(
    "operation.execute",
    z.object({ operationId: z.string().uuid() }).strict(),
  ),
  message(
    "operation.reject",
    z.object({ operationId: z.string().uuid() }).strict(),
  ),
  message(
    "operation.status",
    z.object({ operationId: z.string().uuid() }).strict(),
  ),
]);
export type WorkerRequest = z.infer<typeof workerRequestSchema>;
export type WorkerMethod = WorkerRequest["method"];
export type WorkerPayload<M extends WorkerMethod> = Extract<
  WorkerRequest,
  { method: M }
>["payload"];
export const workerReplySchema = z.discriminatedUnion("ok", [
  z.object({
    protocolVersion: z.literal(1),
    id: z.string().uuid(),
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    protocolVersion: z.literal(1),
    id: z.string().uuid(),
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      correlationId: z.string(),
    }),
  }),
]);
export type WorkerReply = z.infer<typeof workerReplySchema>;
export function parseWorkerRequest(input: unknown) {
  const encoded = JSON.stringify(input);
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).length > 131072
  )
    throw new Error("Worker request exceeds 128 KiB");
  return workerRequestSchema.parse(input);
}
