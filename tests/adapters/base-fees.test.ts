import { it, expect } from "vitest";
import { Interface } from "ethers";
import { quoteBaseFees } from "../../packages/chain-evm/src/base-fees";
const iface = new Interface([
  "function isFjord() view returns(bool)",
  "function getL1FeeUpperBound(uint256) view returns(uint256)",
  "function getOperatorFee(uint256) view returns(uint256)",
]);
it("includes both L1 and operator components and refuses an incomplete oracle", async () => {
  const calls: string[] = [],
    provider = {
      send: async (method: string, params: unknown[]) => {
        if (method === "eth_chainId") return "0x14a34";
        const tx = params[0] as { to: string; data: string },
          parsed = iface.parseTransaction(tx)!;
        calls.push(parsed.name);
        if (parsed.name === "getL1FeeUpperBound")
          expect(parsed.args[0]).toBe(2n);
        if (parsed.name === "getOperatorFee")
          expect(parsed.args[0]).toBe(25200n);
        return iface.encodeFunctionResult(parsed.name, [
          parsed.name === "isFjord"
            ? true
            : parsed.name === "getL1FeeUpperBound"
              ? 1000n
              : 10n,
        ]);
      },
    },
    quote = await quoteBaseFees(provider, "0x0102", 25200n);
  expect(quote.maximumExtra).toBe(2020n);
  expect(calls).toEqual(["isFjord", "getL1FeeUpperBound", "getOperatorFee"]);
  await expect(
    quoteBaseFees(
      {
        send: async () => {
          throw new Error("RPC unavailable");
        },
      },
      "0x0102",
      25200n,
    ),
  ).rejects.toThrow("Complete Base");
});
