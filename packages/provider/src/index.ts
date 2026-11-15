export { registerEWalletSolana } from "./solana";
import {
  connectorResponseSchema,
  connectorMethods,
  type ConnectorRequest,
} from "@ewallet/domain";
export class EWalletProviderError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}
type Family = ConnectorRequest["family"];
type Pending = {
  request: ConnectorRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export function createEWalletConnector({ walletUrl }: { walletUrl: string }) {
  const wallet = new URL(walletUrl);
  if (
    wallet.username ||
    wallet.password ||
    wallet.search ||
    wallet.hash ||
    wallet.pathname !== "/" ||
    (wallet.protocol !== "https:" &&
      !(wallet.protocol === "http:" && wallet.hostname === "127.0.0.1"))
  )
    throw new EWalletProviderError(
      4900,
      "Use an HTTPS wallet URL or the explicit local wallet origin.",
    );
  if (window.top !== window)
    throw new EWalletProviderError(
      4100,
      "The reference connector is available only in a top-level page.",
    );
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>(),
    queue: Pending[] = [];
  let active: {
    pending: Pending;
    popup: Window;
    hello: ReturnType<typeof setInterval>;
    closed: ReturnType<typeof setInterval>;
  } | null = null;
  const peers = new Map<
    Family,
    {
      popup: Window;
      channel: string;
      requestId: string;
      poll: ReturnType<typeof setInterval>;
    }
  >();
  const state = new Map<
    Family,
    { accounts: string[]; networkId: string; expiresAt: string }
  >();
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const random = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  function cleanup() {
    if (!active) return;
    clearInterval(active.hello);
    clearInterval(active.closed);
    active = null;
  }
  function complete(error: Error | null, value?: unknown) {
    if (!active) return;
    const pending = active.pending,
      popup = active.popup,
      keep =
        !error &&
        [
          "eth_requestAccounts",
          "solana:connect",
          "bitcoin:getAccounts",
        ].includes(pending.request.method);
    cleanup();
    clearTimeout(pending.timer);
    if (keep) {
      const family = pending.request.family,
        previous = peers.get(family);
      if (previous) {
        clearInterval(previous.poll);
        if (!previous.popup.closed) previous.popup.close();
      }
      const peer = {
        popup,
        channel: pending.request.channel,
        requestId: pending.request.requestId,
        poll: setInterval(() => {
          if (popup.closed && peers.get(family) === peer) {
            clearInterval(peer.poll);
            peers.delete(family);
            state.delete(family);
            emit("sessionDisconnected", family);
            if (family === "evm") {
              emit("accountsChanged", []);
              emit("disconnect", {
                code: 4900,
                message: "Connection window closed.",
              });
            }
          }
        }, 250),
      };
      peers.set(family, peer);
    }
    if (error) pending.reject(error);
    else pending.resolve(value);
    if (!keep && !popup.closed) popup.close();
    if (queue.length) emit("approvalRequired");
  }

  function openApproval(options: { asTab?: boolean } = {}) {
    if (active || !queue.length) return;
    const pending = queue[0];
    if (pending.request.expiresAt <= Date.now()) {
      queue.shift();
      clearTimeout(pending.timer);
      pending.reject(new EWalletProviderError(4001, "This request expired."));
      return;
    }
    const url = new URL("/connect", wallet.origin);
    url.hash = "channel=" + pending.request.channel;
    const popup = window.open(
      url.toString(),
      "ewallet-approval-" + pending.request.channel,
      options.asTab ? undefined : "popup,width=460,height=720",
    );
    if (!popup) {
      emit("approvalRequired");
      return;
    }
    queue.shift();
    const hello = () => {
      if (!popup.closed)
        popup.postMessage(
          {
            type: "ewallet:hello",
            version: 1,
            channel: pending.request.channel,
            requestId: pending.request.requestId,
            expiresAt: pending.request.expiresAt,
          },
          wallet.origin,
        );
    };
    active = {
      pending,
      popup,
      hello: setInterval(hello, 250),
      closed: setInterval(() => {
        if (popup.closed)
          complete(
            new EWalletProviderError(4001, "Wallet approval window closed."),
          );
      }, 250),
    };
    hello();
  }
  const message = (event: MessageEvent) => {
    if (event.origin !== wallet.origin) return;
    const parsed = connectorResponseSchema.safeParse(event.data);
    if (!parsed.success) return;
    const response = parsed.data;
    if (response.type === "ewallet:event") {
      for (const [family, peer] of peers) {
        if (
          event.source !== peer.popup ||
          response.channel !== peer.channel ||
          response.requestId !== peer.requestId
        )
          continue;
        if (response.event === "disconnect") {
          state.delete(family);
          emit("sessionDisconnected", family);
          if (family === "evm") {
            emit("accountsChanged", []);
            emit("disconnect", { code: 4900, message: "Wallet disconnected." });
          }
        } else {
          const previous = state.get(family);
          if (previous) {
            const next = {
              ...previous,
              ...(response.accounts ? { accounts: response.accounts } : {}),
              ...(response.networkId ? { networkId: response.networkId } : {}),
            };
            state.set(family, next);
            emit("sessionChanged", family, next);
            if (family === "evm") {
              if (response.event === "accountsChanged")
                emit("accountsChanged", next.accounts);
              else
                emit(
                  "chainChanged",
                  "0x" + BigInt(next.networkId.split(":")[1]).toString(16),
                );
            }
          }
        }
      }
      return;
    }
    const current = active;
    if (!current || event.source !== current.popup) return;
    const r = current.pending.request;
    if (
      response.channel !== r.channel ||
      response.requestId !== r.requestId ||
      Date.now() > r.expiresAt
    )
      return;
    if (response.type === "ewallet:ready") {
      clearInterval(current.hello);
      current.popup.postMessage(r, wallet.origin);
    } else if (response.type === "ewallet:verify")
      current.popup.postMessage(
        {
          type: "ewallet:verifyAck",
          version: 1,
          channel: r.channel,
          requestId: r.requestId,
          challenge: response.challenge,
        },
        wallet.origin,
      );
    else if (response.type === "ewallet:error") {
      if (response.error.code === 4100 || response.error.code === 4900) {
        state.delete(r.family);
        emit("sessionDisconnected", r.family);
        if (r.family === "evm")
          emit("disconnect", {
            code: response.error.code,
            message: response.error.message,
          });
      }
      complete(
        new EWalletProviderError(response.error.code, response.error.message),
      );
    } else {
      const result = response.result as {
        accounts?: string[];
        networkId?: string;
        expiresAt?: string;
      };
      if (
        result &&
        Array.isArray(result.accounts) &&
        typeof result.networkId === "string"
      ) {
        const previous = state.get(r.family);
        state.set(r.family, {
          accounts: result.accounts,
          networkId: result.networkId,
          expiresAt:
            result.expiresAt ?? new Date(Date.now() + 86400000).toISOString(),
        });
        emit("sessionChanged", r.family, state.get(r.family));
        if (r.family === "evm") {
          if (
            JSON.stringify(previous?.accounts) !==
            JSON.stringify(result.accounts)
          )
            emit("accountsChanged", result.accounts);
          if (previous?.networkId !== result.networkId)
            emit(
              "chainChanged",
              "0x" + BigInt(result.networkId.split(":")[1]).toString(16),
            );
          emit("connect", { chainId: "0x"+BigInt(result.networkId.split(":")[1]).toString(16) });
        }
      }
      complete(null, response.result);
    }
  };
  window.addEventListener("message", message);
  function request(family: Family, method: string, params: unknown[] = []) {
    if (
      !(connectorMethods[family] as readonly string[]).includes(method) &&
      method !== "disconnect"
    )
      return Promise.reject(
        new EWalletProviderError(4200, "Unsupported connector method."),
      );
    if (queue.length >= 5)
      return Promise.reject(
        new EWalletProviderError(
          4001,
          "The five-request approval queue is full.",
        ),
      );
    return new Promise<unknown>((resolve, reject) => {
      const request: ConnectorRequest = {
        type: "ewallet:request",
        version: 1,
        channel: random(),
        requestId: crypto.randomUUID(),
        family,
        method,
        params,
        expiresAt: Date.now() + 120000,
      };
      if (new TextEncoder().encode(JSON.stringify(request)).length > 131072) {
        reject(new EWalletProviderError(-32602, "Request exceeds 128 KiB."));
        return;
      }
      const pending: Pending = {
        request,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (active?.pending === pending)
            complete(new EWalletProviderError(4001, "Wallet request expired."));
          else {
            const index = queue.indexOf(pending);
            if (index >= 0) queue.splice(index, 1);
            reject(new EWalletProviderError(4001, "Wallet request expired."));
          }
        }, 120000),
      };
      queue.push(pending);
      if (!active) openApproval();
      else emit("approvalRequired");
    });
  }
  function cached(family: Family) {
    const peer = peers.get(family);
    if (peer?.popup.closed) state.delete(family);
    const value = state.get(family);
    return value && Date.parse(value.expiresAt) > Date.now() ? value : null;
  }
  const connector = {
    request,
    openApproval,
    hasPendingApproval: () => queue.length > 0,
    on(event: string, listener: (...args: unknown[]) => void) {
      let group = listeners.get(event);
      if (!group) {
        group = new Set();
        listeners.set(event, group);
      }
      group.add(listener);
      return () => group.delete(listener);
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
    },
    getSession: cached,
    connect(family: Family) {
      return request(
        family,
        family === "evm"
          ? "eth_requestAccounts"
          : family === "solana"
            ? "solana:connect"
            : "bitcoin:getAccounts",
        [{ methods: [...connectorMethods[family]] }],
      );
    },
    async disconnect(family: Family) {
      const result = await request(family, "disconnect");
      state.delete(family);
      const peer = peers.get(family);
      if (peer) {
        clearInterval(peer.poll);
        if (!peer.popup.closed) peer.popup.close();
        peers.delete(family);
      }
      emit("sessionDisconnected", family);
      if (family === "evm") {
        emit("accountsChanged", []);
        emit("disconnect", {
          code: 4900,
          message: "Disconnected by the site.",
        });
      }
      return result;
    },
    evm: {
      async request({
        method,
        params = [],
      }: {
        method: string;
        params?: unknown[];
      }) {
        if (method === "eth_accounts") return cached("evm")?.accounts ?? [];
        if (method === "eth_chainId" && cached("evm"))
          return (
            "0x" + BigInt(cached("evm")!.networkId.split(":")[1]).toString(16)
          );
        const result = (await request("evm", method, params)) as {
          accounts?: string[];
          hash?: string;
          signature?: string;
          networkId?: string;
        };
        return method === "eth_chainId" && result.networkId
          ? "0x" + BigInt(result.networkId.split(":")[1]).toString(16)
          : method === "eth_requestAccounts"
            ? (result.accounts ?? [])
            : method === "eth_sendTransaction"
              ? result.hash
              : method === "personal_sign" || method === "eth_signTypedData_v4"
                ? result.signature
                : method === "wallet_switchEthereumChain"
                  ? null
                  : result;
      },
      on: (event: string, listener: (...args: unknown[]) => void) =>
        connector.on(event, listener),
      removeListener: (event: string, listener: (...args: unknown[]) => void) =>
        connector.removeListener(event, listener),
    },
    bitcoin: {
      getAccounts: () => request("bitcoin", "bitcoin:getAccounts"),
      getNetwork: () => cached("bitcoin")?.networkId ?? null,
      signPsbt: (psbt: string, changeIndex?: number) =>
        request("bitcoin", "bitcoin:signPsbt", [
          { psbt, ...(changeIndex !== undefined ? { changeIndex } : {}) },
        ]),
      broadcastTransaction: (transaction: string) =>
        request("bitcoin", "bitcoin:broadcastTransaction", [{ transaction }]),
      disconnect: () => connector.disconnect("bitcoin"),
    },
    dispose() {
      window.removeEventListener("message", message);
      if (active)
        complete(new EWalletProviderError(4900, "Connector disposed."));
      for (const pending of queue.splice(0)) {
        clearTimeout(pending.timer);
        pending.reject(new EWalletProviderError(4900, "Connector disposed."));
      }
      for (const peer of peers.values()) {
        clearInterval(peer.poll);
        if (!peer.popup.closed) peer.popup.close();
      }
      peers.clear();
      listeners.clear();
    },
  };
  return connector;
}
export type EWalletConnector = ReturnType<typeof createEWalletConnector>;
