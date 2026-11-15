import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  parseAmount,
  formatAmount,
  demoValue,
  formatUsd,
  transactionIntentSchema,
  assetBalanceSchema,
} from "@ewallet/domain";
import { MockWalletGateway } from "../apps/wallet/src/mock-gateway";
describe("exact quantities", () => {
  it("retains one wei and integers beyond Number.MAX_SAFE_INTEGER", () => {
    expect(parseAmount("0.000000000000000001", 18)).toBe(1n);
    expect(parseAmount("9007199254740993.12", 6)).toBe(9007199254740993120000n);
    expect(formatUsd("9007199254740993120000")).toBe(
      "$9,007,199,254,740,993.12",
    );
  });
  it("rejects unsafe human inputs and unsupported precision", () => {
    for (const x of [
      "1e3",
      "-1",
      "NaN",
      "Infinity",
      " 1",
      "1 ",
      "+1",
      ".1",
      "01",
      "1.",
      "0x10",
    ])
      expect(() => parseAmount(x, 18)).toThrow();
    expect(() => parseAmount("1.001", 2)).toThrow();
    expect(() => parseAmount("1", 37)).toThrow();
  });
  it("round trips integer base units without floating point", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 70n }),
        fc.integer({ min: 0, max: 36 }),
        (raw, d) => {
          expect(parseAmount(formatAmount(raw, d), d)).toBe(raw);
        },
      ),
      { numRuns: 500 },
    );
  });
  it("distinguishes unpriced and unavailable data", () => {
    const g = new MockWalletGateway();
    g.loadSample();
    const b = g.getSnapshot().balances;
    expect(demoValue(b).priceSource).toBe("demo");
    expect(demoValue([{ ...b[0], microUsdRate: null }]).missingPriceCount).toBe(
      1,
    );
    expect(() =>
      assetBalanceSchema.parse({
        ...b[0],
        available: (BigInt(b[0].raw) + 1n).toString(),
      }),
    ).toThrow();
  });
  it("rejects cross-network intent serialization", () => {
    expect(() =>
      transactionIntentSchema.parse({
        requestId: "x",
        accountId: "a",
        networkId: "eip155:31337",
        kind: "send",
        recipient: "x",
        asset: {
          networkId: "solana:local",
          standard: "native",
          reference: "native",
        },
        amount: "1",
      }),
    ).toThrow();
  });
});
