// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import { createEWalletConnector } from "@ewallet/provider";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("accepts replies only from the bound origin/window/channel/request and clears accounts when its peer closes", async () => {
  vi.useFakeTimers();
  const postMessage = vi.fn(),
    popup = { closed: false, postMessage, close: vi.fn() },
    open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window),
    connector = createEWalletConnector({ walletUrl: "https://wallet.test/" });
  const pending = connector.connect("evm");
  expect(open.mock.calls[0][0]).toMatch(
    /^https:\/\/wallet.test\/connect#channel=[a-f0-9]{64}$/,
  );
  const hello = postMessage.mock.calls[0][0],
    ready = {
      type: "ewallet:ready",
      version: 1,
      channel: hello.channel,
      requestId: hello.requestId,
    },
    send = (
      data: unknown,
      origin = "https://wallet.test",
      source: unknown = popup,
    ) =>
      window.dispatchEvent(
        new MessageEvent("message", { data, origin, source: source as Window }),
      );
  send(ready);
  const request = postMessage.mock.calls.at(-1)![0];
  expect(request.type).toBe("ewallet:request");
  const result = {
    type: "ewallet:result",
    version: 1,
    channel: hello.channel,
    requestId: hello.requestId,
    result: {
      accounts: ["0x1111111111111111111111111111111111111111"],
      networkId: "eip155:31337",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  };
  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });
  send(result, "https://evil.test");
  send(result, "https://wallet.test", {});
  send({ ...result, channel: "0".repeat(64) });
  send({ ...result, requestId: crypto.randomUUID() });
  await Promise.resolve();
  expect(resolved).toBe(false);
  send(result);
  await pending;
  expect(await connector.evm.request({ method: "eth_accounts" })).toEqual(
    result.result.accounts,
  );
  popup.closed = true;
  await vi.advanceTimersByTimeAsync(300);
  expect(await connector.evm.request({ method: "eth_accounts" })).toEqual([]);
  connector.dispose();
});
it("offers an explicit popup-blocked retry and rejects oversized/unsupported/flooded requests", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, "open").mockReturnValue(null);
  const connector = createEWalletConnector({
      walletUrl: "https://wallet.test/",
    }),
    required = vi.fn();
  connector.on("approvalRequired", required);
  const pending = connector.connect("evm");
  void pending.catch(() => {});
  expect(required).toHaveBeenCalled();
  expect(connector.hasPendingApproval()).toBe(true);
  connector.openApproval({ asTab: true });
  await expect(connector.request("evm", "eth_sign")).rejects.toMatchObject({
    code: 4200,
  });
  await expect(
    connector.request("evm", "personal_sign", ["x".repeat(140000)]),
  ).rejects.toMatchObject({ code: -32602 });
  const queue = Array.from({ length: 4 }, () =>
    connector.request("evm", "eth_chainId"),
  );
  queue.forEach((p) => void p.catch(() => {}));
  await expect(connector.request("evm", "eth_chainId")).rejects.toMatchObject({
    code: 4001,
  });
  connector.dispose();
  await expect(pending).rejects.toMatchObject({ code: 4900 });
});
