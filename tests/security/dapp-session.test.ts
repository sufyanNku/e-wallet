import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import { Interface } from "ethers";
import { VaultStore } from "../../packages/wallet-core/src/storage";
import {
  DappSessions,
  decodeEvmDappIntent,
} from "../../packages/wallet-core/src/dapp";
import {
  importSecret,
  derivePublic,
} from "../../packages/wallet-core/src/derivation";
import { abis } from "@ewallet/config/abis";
import type { ConnectorRequest } from "@ewallet/domain";
const secret = importSecret(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  ),
  account = derivePublic(secret, "vector", { family: "evm", index: 0 }),
  origin = "https://example.test";
function request(
  method = "personal_sign",
  params: unknown[] = ["0x6869", account.address],
): ConnectorRequest {
  return {
    type: "ewallet:request",
    version: 1,
    channel: crypto.randomUUID().replaceAll("-", "").repeat(2),
    requestId: crypto.randomUUID(),
    family: "evm",
    method,
    params,
    expiresAt: Date.now() + 120000,
  };
}
it("binds message approvals to their channel, digest, grant, expiry and single use; persists only public request IDs", async () => {
  const store = new VaultStore("local", crypto.randomUUID());
  let now = Date.now();
  const sessions = new DappSessions(
      store,
      async () => ({ account, networkId: "eip155:31337" }),
      async () => {
        throw new Error("unused");
      },
      () => now,
    ),
    r = request();
  r.expiresAt = now + 120000;
  await sessions.open(origin, r);
  await expect(sessions.prepareMessage(r.channel)).rejects.toThrow(
    "no current grant",
  );
  const grant = await sessions.grant(r.channel),
    review = await sessions.prepareMessage(r.channel);
  await expect(
    sessions.signMessage(r.channel, review.id, "0".repeat(64), secret),
  ).rejects.toThrow("changed");
  await sessions.revoke(grant.id);
  await expect(
    sessions.signMessage(r.channel, review.id, review.digest, secret),
  ).rejects.toThrow("no current grant");
  await sessions.grant(r.channel);
  const result = await sessions.signMessage(
    r.channel,
    review.id,
    review.digest,
    secret,
  );
  expect(result.account).toBe(account.address);
  await expect(
    sessions.signMessage(r.channel, review.id, review.digest, secret),
  ).rejects.toThrow("consumed");
  await expect(
    sessions.open(origin, { ...r, channel: request().channel }),
  ).rejects.toThrow("already received");
  const next = request();
  next.expiresAt = now + 120000;
  await sessions.open(origin, next);
  await sessions.grant(next.channel);
  const expiring = await sessions.prepareMessage(next.channel);
  now += 60001;
  await expect(
    sessions.signMessage(next.channel, expiring.id, expiring.digest, secret),
  ).rejects.toThrow("expired");
  const stored = JSON.stringify(await store.allJournal());
  expect(stored).not.toContain(r.channel);
  expect(stored).not.toContain("messageHex");
  expect(stored).not.toContain(result.signature);
  await store.close();
});
it("rejects opaque origins, unsupported methods, trailing calldata and wrong signer/chain", async () => {
  const store = new VaultStore("local", crypto.randomUUID()),
    sessions = new DappSessions(
      store,
      async () => ({ account, networkId: "eip155:31337" }),
      async () => {
        throw new Error("unused");
      },
    );
  await expect(sessions.open("null", request())).rejects.toThrow("Opaque");
  await expect(sessions.open(origin, request("eth_sign"))).rejects.toThrow(
    "Unsupported",
  );
  const token = new Interface(abis.DemoERC20),
    r = request("eth_sendTransaction", [
      {
        from: account.address,
        to: "0x1111111111111111111111111111111111111111",
        data:
          token.encodeFunctionData("transfer", [
            "0x2222222222222222222222222222222222222222",
            1n,
          ]) + "00",
      },
    ]);
  expect(() =>
    decodeEvmDappIntent(
      {
        origin,
        request: r,
        expiresAt: r.expiresAt,
        grantId: null,
        preparedId: null,
        consumed: false,
      },
      account,
      "eip155:31337",
    ),
  ).toThrow("trailing");
  await store.close();
});
