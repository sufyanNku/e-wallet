import { it, expect, vi } from "vitest";
import { rpcUpstream, validateRpc } from "../../services/backend/src/rpc";
it("retains exact Solana u64 values and Bitcoin satoshi decimals at the JSON boundary", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        '{"result":{"lamports":18446744073709551615,"amount":0.00000001,"negative":-0.00000001}}',
      ),
  );
  try {
    const response = await rpcUpstream(
      "http://127.0.0.1:8899",
      "getBalance",
      [],
      undefined,
      true,
    );
    expect(response).toEqual({
      result: {
        lamports: "18446744073709551615",
        amount: "0.00000001",
        negative: "-0.00000001",
      },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
it("rejects Solana faucet and Bitcoin wallet/admin methods at the public boundary", () => {
  for (const method of ["requestAirdrop", "setAccount", "validatorExit"])
    expect(() => validateRpc(method, [], "solana")).toThrow("Unsupported");
  for (const method of [
    "importdescriptors",
    "dumpprivkey",
    "walletcreatefundedpsbt",
    "generatetoaddress",
    "createwallet",
  ])
    expect(() => validateRpc(method, [], "bitcoin")).toThrow("Unsupported");
});
