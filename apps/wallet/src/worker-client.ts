import { WalletError } from "@ewallet/domain";
import {
  parseWorkerRequest,
  workerReplySchema,
  type WorkerMethod,
  type WorkerPayload,
} from "@ewallet/domain/protocol";
export class WorkerClient {
  private worker: Worker;
  private ready: Promise<void> = Promise.resolve();
  private readyResolve: () => void = () => {};
  private pending = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private onLock: (reason: string) => void) {
    this.worker = this.start();
  }
  private start() {
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    const worker = new Worker(new URL("./signing.worker.ts", import.meta.url), {
      type: "module",
      name: "e-wallet-signing",
    });
    worker.onmessage = (event) => {
      const message = event.data;
      if (message?.event === "ready" && message.protocolVersion === 1) {
        this.readyResolve();
        return;
      }
      if (message?.event === "locked" && typeof message.reason === "string") {
        this.onLock(message.reason);
        return;
      }
      const parsed = workerReplySchema.safeParse(message);
      if (!parsed.success) return;
      const r = parsed.data,
        p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      if (r.ok) p.resolve(r.data);
      else
        p.reject(
          new WalletError(r.error.code, r.error.message, r.error.retryable),
        );
    };
    worker.onerror = () => {
      this.rejectAll("The signing Worker stopped. Reload and unlock again.");
      this.onLock("Signing Worker unavailable");
    };
    return worker;
  }
  request<M extends WorkerMethod>(
    method: M,
    payload: WorkerPayload<M>,
  ): Promise<unknown> {
    if (this.pending.size >= 16)
      return Promise.reject(
        new WalletError("REQUEST_LIMIT", "Too many pending wallet requests."),
      );
    const id = crypto.randomUUID();
    let message;
    try {
      message = parseWorkerRequest({ protocolVersion: 1, id, method, payload });
    } catch {
      return Promise.reject(
        new WalletError(
          "INVALID_REQUEST",
          method === "vault.unlock"
            ? "Enter your wallet password, up to 1,024 UTF-8 bytes."
            : "Invalid wallet request.",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new WalletError(
            "WORKER_TIMEOUT",
            "Wallet request timed out. Check its status before retrying.",
            true,
          ),
        );
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      const worker = this.worker;
      void this.ready.then(() => {
        if (this.pending.has(id) && worker === this.worker)
          worker.postMessage(message);
      });
    });
  }
  private rejectAll(message: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new WalletError("LOCKED", message));
    }
    this.pending.clear();
  }
  restart() {
    this.worker.terminate();
    this.rejectAll("Wallet locked. Pending requests were cancelled.");
    this.worker = this.start();
  }
  dispose() {
    this.worker.terminate();
    this.rejectAll("Wallet window closed.");
  }
}
