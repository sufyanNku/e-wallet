import { preparedOperationSchema } from "@ewallet/domain";

export function operationFixture() {
  const now = Date.now();
  return preparedOperationSchema.parse({
    id: crypto.randomUUID(),
    intent: {
      requestId: crypto.randomUUID(),
      accountId: "alice",
      networkId: "eip155:31337",
      kind: "send",
      recipient: "0x2222222222222222222222222222222222222222",
      asset: {
        networkId: "eip155:31337",
        standard: "native",
        reference: "native",
      },
      amount: "1",
    },
    encodedPayload: "{}",
    preview: {
      title: "Send",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: "1",
      warnings: [],
    },
    fee: { estimated: "21000", maximum: "42000", symbol: "ETH", decimals: 18 },
    createdAt: now,
    expiresAt: now + 30000,
    fingerprint: "isolated-unit-test",
    digest: "1".repeat(64),
    source: "fixture",
  });
}
