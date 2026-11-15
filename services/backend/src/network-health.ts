import { networks } from "@ewallet/config";
import { networkRpc } from "./node-rpc";
import { bitcoinIdentity } from "./bitcoin-rpc";
type Observation = {
  state: "passed" | "blocked_rpc" | "failed";
  observed: string | null;
  observedAt: string;
  errorCode?: string;
};
const cache = new Map<string, Observation>();
let pending: Promise<void> | null = null,
  lastProbe = 0;
export function networkHealth() {
  if (!pending && Date.now() - lastProbe > 30000) {
    lastProbe = Date.now();
    const queue = [...networks];
    pending = Promise.all(
      Array.from({ length: 3 }, async () => {
        while (queue.length) {
          const profile = queue.shift()!;
          try {
            const observed =
              profile.family === "evm"
                ? BigInt(
                    String(await networkRpc(profile.id, "eth_chainId")),
                  ).toString()
                : profile.family === "solana"
                  ? String(await networkRpc(profile.id, "getGenesisHash"))
                  : (await bitcoinIdentity()).ledgerFingerprint!;
            const expected =
              profile.family === "bitcoin" ? observed : profile.identity;
            cache.set(profile.id, {
              state:
                (profile.family === "solana" &&
                  profile.environment === "local") ||
                observed === expected
                  ? "passed"
                  : "failed",
              observed,
              observedAt: new Date().toISOString(),
            });
          } catch {
            cache.set(profile.id, {
              state: "blocked_rpc",
              observed: null,
              observedAt: new Date().toISOString(),
              errorCode: "RPC_UNAVAILABLE",
            });
          }
        }
      }),
    )
      .then(() => {})
      .finally(() => {
        pending = null;
      });
  }
  return networks.map((profile) => ({
    ...profile,
    health: cache.get(profile.id) ?? {
      state: "checking",
      observed: null,
      observedAt: null,
    },
    stale: cache.has(profile.id)
      ? Date.now() - Date.parse(cache.get(profile.id)!.observedAt) > 60000
      : true,
  }));
}
