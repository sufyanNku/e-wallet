import { it, expect } from "vitest";
import { marketReader } from "../../services/backend/src/markets";
it("fetches only fixed price pairs, deduplicates concurrent loads, and preserves stale observations on outage", async () => {
  let now = 100000,
    calls = 0,
    offline = false;
  const urls: string[] = [];
  const transport: typeof fetch = async (input) => {
    calls++;
    urls.push(String(input));
    if (offline) throw new Error("offline");
    return new Response(
      JSON.stringify({ data: { amount: "123.456789123456", currency: "USD" } }),
    );
  };
  const read = marketReader(transport, () => now);
  const [a, b] = await Promise.all([read(), read()]);
  expect(calls).toBe(3);
  expect(a).toEqual(b);
  expect(a.stale).toBe(false);
  expect(a.assets[0].microUsd).toBe("123456789");
  expect(
    urls.every((u) =>
      /^https:\/\/api.coinbase.com\/v2\/prices\/(BTC|ETH|SOL)-USD\/spot$/.test(
        u,
      ),
    ),
  ).toBe(true);
  await read();
  expect(calls).toBe(3);
  now += 61000;
  offline = true;
  const stale = await read();
  expect(stale.stale).toBe(true);
  expect(stale.observedAt).toBe(a.observedAt);
  expect(stale.assets).toEqual(a.assets);
});
it("rejects oversized and non-USD provider responses without inventing prices", async () => {
  const read = marketReader(
    async () =>
      new Response(
        JSON.stringify({ data: { amount: "100", currency: "EUR" } }),
      ),
  );
  expect((await read()).assets).toEqual([]);
  const oversized = marketReader(async () => new Response("a".repeat(17000)));
  const result = await oversized();
  expect(result.assets).toEqual([]);
  expect(result.observedAt).toBeNull();
});
