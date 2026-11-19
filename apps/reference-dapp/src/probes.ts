import type { ConnectorRequest } from "@ewallet/domain";
type Probe =
  | "connect"
  | "wrong-channel"
  | "wrong-target-origin"
  | "tampered"
  | "replay";
let recorded: ConnectorRequest | null = null;
export function protocolProbe(kind: Probe): Promise<unknown> {
  const origin = new URL(
      import.meta.env.VITE_EWALLET_APPROVAL_URL ?? "http://127.0.0.1:8787",
    ).origin,
    channel = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
    request: ConnectorRequest = {
      type: "ewallet:request",
      version: 1,
      channel,
      requestId:
        kind === "replay" && recorded
          ? recorded.requestId
          : crypto.randomUUID(),
      family: "evm",
      method: "eth_requestAccounts",
      params: [
        { methods: ["eth_requestAccounts", "eth_accounts", "eth_chainId"] },
      ],
      expiresAt: Date.now() + 120000,
    },
    popup = window.open(
      origin + "/connect#channel=" + channel,
      "ewallet-probe-" + channel,
      "popup,width=460,height=720",
    );
  if (!popup)
    return Promise.reject(
      new Error("Popup blocked; retry directly from this button."),
    );
  if (kind === "replay" && !recorded) {
    popup.close();
    return Promise.reject(
      new Error(
        "Use Protocol connect first and explicitly approve it, then replay its public request ID.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    let sent = false,
      finished = false;
    const timeout = setTimeout(
        () => finish(new Error("Probe expired without an approval.")),
        120000,
      ),
      hello = setInterval(
        () =>
          popup.postMessage(
            {
              type: "ewallet:hello",
              version: 1,
              channel,
              requestId: request.requestId,
              expiresAt: request.expiresAt,
            },
            origin,
          ),
        250,
      ),
      closed = setInterval(() => {
        if (popup.closed) finish(new Error("Probe window closed."));
      }, 250);
    let ignoredTimer: ReturnType<typeof setTimeout> | undefined;
    function finish(error: Error | null, value?: unknown) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(hello);
      clearInterval(closed);
      if (ignoredTimer) clearTimeout(ignoredTimer);
      window.removeEventListener("message", receive);
      if (!popup!.closed) popup!.close();
      if (error) reject(error);
      else resolve(value);
    }
    function receive(event: MessageEvent) {
      if (
        event.source !== popup ||
        event.origin !== origin ||
        event.data?.version !== 1 ||
        event.data?.channel !== channel ||
        event.data?.requestId !== request.requestId
      )
        return;
      const data = event.data;
      if (data.type === "ewallet:ready" && !sent) {
        sent = true;
        clearInterval(hello);
        popup!.postMessage(
          kind === "wrong-channel"
            ? { ...request, channel: "0".repeat(64) }
            : request,
          kind === "wrong-target-origin" ? "https://example.invalid" : origin,
        );
        if (kind === "wrong-channel" || kind === "wrong-target-origin")
          ignoredTimer = setTimeout(
            () =>
              finish(null, {
                probe: kind,
                ignored: true,
                replyReceived: false,
              }),
            2500,
          );
        if (kind === "tampered")
          setTimeout(
            () =>
              popup!.postMessage(
                {
                  ...request,
                  params: [
                    { methods: ["eth_requestAccounts", "personal_sign"] },
                  ],
                },
                origin,
              ),
            100,
          );
      } else if (data.type === "ewallet:verify")
        popup!.postMessage(
          {
            type: "ewallet:verifyAck",
            version: 1,
            channel,
            requestId: request.requestId,
            challenge: data.challenge,
          },
          origin,
        );
      else if (data.type === "ewallet:error")
        finish(null, {
          probe: kind,
          rejected: true,
          code: data.error.code,
          message: data.error.message,
        });
      else if (data.type === "ewallet:result") {
        if (kind === "connect") recorded = request;
        finish(null, { probe: kind, result: data.result });
      }
    }
    window.addEventListener("message", receive);
  });
}
