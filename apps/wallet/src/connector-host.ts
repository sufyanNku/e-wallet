import {
  connectorHelloSchema,
  connectorAckSchema,
  parseConnectorRequest,
  assertConnectorOrigin,
  type ConnectorRequest,
} from "@ewallet/domain";
export class ConnectorHost {
  private peer: Window | null = null;
  private origin = "";
  private helloId: string | null = null;
  private request: ConnectorRequest | null = null;
  private challenge: {
    id: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private done = false;
  readonly channel: string;
  constructor(
    private onRequest: (origin: string, request: ConnectorRequest) => void,
    private onInvalid: (message: string) => void,
  ) {
    const params = new URLSearchParams(window.location.hash.slice(1)),
      channel = params.get("channel");
    if (
      window.top !== window ||
      !window.opener ||
      !channel ||
      !/^[0-9a-f]{64}$/.test(channel) ||
      Array.from(params.keys()).some((k) => k !== "channel")
    )
      throw new Error("Open this approval window from the requesting site.");
    this.channel = channel;
    window.addEventListener("message", this.receive);
    window.addEventListener("beforeunload", this.unload);
  }
  private receive = (event: MessageEvent) => {
    if (this.done || event.source !== window.opener || event.source === null)
      return;
    let origin: string;
    try {
      origin = assertConnectorOrigin(event.origin);
    } catch {
      return;
    }
    if (this.peer && (event.source !== this.peer || origin !== this.origin)) {
      this.cancel("The requesting page changed origin.");
      return;
    }
    const hello = connectorHelloSchema.safeParse(event.data);
    if (hello.success) {
      if (
        hello.data.channel !== this.channel ||
        hello.data.expiresAt <= Date.now() ||
        hello.data.expiresAt > Date.now() + 120000
      )
        return;
      if (this.request && this.request.requestId !== hello.data.requestId) {
        this.cancel("A second request attempted to reuse this channel.");
        return;
      }
      if (this.helloId && this.helloId !== hello.data.requestId) {
        this.cancel("A different request attempted to reuse this handshake.");
        return;
      }
      this.helloId = hello.data.requestId;
      this.peer = event.source as Window;
      this.origin = origin;
      this.peer.postMessage(
        {
          type: "ewallet:ready",
          version: 1,
          channel: this.channel,
          requestId: hello.data.requestId,
        },
        origin,
      );
      return;
    }
    const ack = connectorAckSchema.safeParse(event.data);
    if (
      ack.success &&
      this.request &&
      ack.data.channel === this.channel &&
      ack.data.requestId === this.request.requestId &&
      ack.data.challenge === this.challenge?.id
    ) {
      clearTimeout(this.challenge.timer);
      this.challenge.resolve();
      this.challenge = null;
      return;
    }
    if (!this.peer || event.source !== this.peer || origin !== this.origin)
      return;
    let request: ConnectorRequest;
    try {
      request = parseConnectorRequest(event.data);
    } catch {
      this.sendError(4200, "Unsupported or malformed connector request.");
      return;
    }
    if (
      request.requestId !== this.helloId ||
      request.channel !== this.channel ||
      request.expiresAt <= Date.now() ||
      request.expiresAt > Date.now() + 120000
    )
      return;
    if (this.request) {
      this.cancel("A second or changed payload attempted to reuse this active request.");
      return;
    }
    this.request = structuredClone(request);
    this.onRequest(origin, structuredClone(request));
  };
  verify() {
    if (
      !this.peer ||
      !this.request ||
      this.done ||
      this.peer.closed ||
      this.request.expiresAt <= Date.now()
    )
      return Promise.reject(
        new Error("The requesting page is closed or the request expired."),
      );
    if (this.challenge)
      return Promise.reject(
        new Error("A peer verification is already active."),
      );
    return new Promise<void>((resolve, reject) => {
      const id = crypto.randomUUID(),
        timer = setTimeout(() => {
          this.challenge = null;
          reject(
            new Error(
              "The requesting page closed, navigated or stopped responding.",
            ),
          );
        }, 2500);
      this.challenge = { id, resolve, reject, timer };
      this.peer!.postMessage(
        {
          type: "ewallet:verify",
          version: 1,
          channel: this.channel,
          requestId: this.request!.requestId,
          challenge: id,
        },
        this.origin,
      );
    });
  }
  result(value: unknown, keepOpen = false) {
    if (!this.request || !this.peer || this.done) return;
    this.peer.postMessage(
      {
        type: "ewallet:result",
        version: 1,
        channel: this.channel,
        requestId: this.request.requestId,
        result: value,
      },
      this.origin,
    );
    if (!keepOpen) this.done = true;
  }
  event(
    event: "accountsChanged" | "chainChanged" | "disconnect",
    accounts?: string[],
    networkId?: string,
  ) {
    if (!this.request || !this.peer || this.peer.closed) return;
    this.peer.postMessage(
      {
        type: "ewallet:event",
        version: 1,
        channel: this.channel,
        requestId: this.request.requestId,
        event,
        ...(accounts ? { accounts } : {}),
        ...(networkId ? { networkId } : {}),
      },
      this.origin,
    );
  }
  sendError(code: number, message: string) {
    if ((!this.request && !this.helloId) || !this.peer) return;
    this.peer.postMessage(
      {
        type: "ewallet:error",
        version: 1,
        channel: this.channel,
        requestId: this.request?.requestId ?? this.helloId!,
        error: { code, message: message.slice(0, 500) },
      },
      this.origin,
    );
    this.done = true;
  }
  cancel(message = "Rejected by the wallet user.") {
    this.sendError(4001, message);
    this.onInvalid(message);
  }
  private unload = () => {
    if (!this.done)
      this.sendError(4001, "Wallet approval window navigated or closed.");
  };
  dispose() {
    window.removeEventListener("message", this.receive);
    window.removeEventListener("beforeunload", this.unload);
    if (this.challenge) {
      clearTimeout(this.challenge.timer);
      this.challenge.reject(new Error("Approval window closed."));
      this.challenge = null;
    }
  }
}
