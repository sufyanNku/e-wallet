/// <reference lib="webworker" />
import { WalletCore, VaultStore } from "@ewallet/wallet-core";
const scope = self as unknown as DedicatedWorkerGlobalScope;
const mode = __WALLET_MODE__ === "testnet" ? "testnet" : "local";
const core = new WalletCore(new VaultStore(mode), mode);
scope.onmessage = (event) => {
  if (!scope.isSecureContext) {
    scope.postMessage({
      protocolVersion: 1,
      id: event.data?.id,
      ok: false,
      error: {
        code: "INSECURE_CONTEXT",
        message:
          "Open the wallet on loopback or HTTPS before using recovery or signing.",
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    });
    return;
  }
  void core.dispatch(event.data).then((reply) => scope.postMessage(reply));
};
scope.postMessage({ event: "ready", protocolVersion: 1 });
// Every message checks deadlines as well; this timer is only a convenience.
let lastReason = "";
setInterval(() => {
  void core.status().then((status) => {
    if (status.locked && status.lockReason !== lastReason) {
      lastReason = status.lockReason;
      scope.postMessage({ event: "locked", reason: status.lockReason });
    }
    if (!status.locked) lastReason = "";
  });
}, 1000);
