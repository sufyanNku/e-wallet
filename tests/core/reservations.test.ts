import { it, expect } from "vitest";
import fc from "fast-check";
import { sumDebits } from "../../packages/wallet-core/src/reservations";
import {
  assetKey,
  type PreparedOperation,
  type TransactionIntent,
} from "@ewallet/domain";
const native = {
    networkId: "eip155:31337",
    standard: "native" as const,
    reference: "native",
  },
  token = {
    networkId: "eip155:31337",
    standard: "erc20" as const,
    reference: "0x1111111111111111111111111111111111111111",
  };
function operation(
  kind: TransactionIntent["kind"],
  amount: bigint,
  fee: bigint,
  nativeAsset = false,
): PreparedOperation {
  return {
    id: crypto.randomUUID(),
    intent: {
      requestId: crypto.randomUUID(),
      accountId: "alice",
      networkId: "eip155:31337",
      kind,
      recipient: "bob",
      asset: nativeAsset ? native : token,
      amount: String(amount),
    },
    encodedPayload: "{}",
    preview: {
      title: kind,
      recipient: "bob",
      amount: String(amount),
      warnings: [],
    },
    fee: {
      estimated: String(fee),
      maximum: String(fee),
      symbol: "ETH",
      decimals: 18,
    },
    createdAt: 0,
    expiresAt: 1,
    fingerprint: "fixture",
    digest: "0".repeat(64),
    source: "fixture",
  };
}
it("reserves native transfers plus maximum fees exactly across many overlapping approvals", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.bigInt({ min: 1n, max: 10n ** 30n }),
          fc.bigInt({ min: 1n, max: 10n ** 20n }),
        ),
        { minLength: 1, maxLength: 30 },
      ),
      (values) => {
        const debits = sumDebits(
          values.map(([amount, fee]) => operation("send", amount, fee, true)),
        );
        expect(debits.get(assetKey(native))).toBe(
          values.reduce((sum, [amount, fee]) => sum + amount + fee, 0n),
        );
      },
    ),
  );
});
it("reserves token debits separately while approvals and shared contract execution reserve only the user gas", () => {
  const debits = sumDebits([
    operation("swap", 17n, 3n),
    operation("approve", 500n, 4n),
    operation("execute", 900n, 5n),
    operation("deposit", 19n, 2n),
  ]);
  expect(debits.get(assetKey(token))).toBe(36n);
  expect(debits.get(assetKey(native))).toBe(14n);
});
