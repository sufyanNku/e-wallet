import { OperationDetails } from "./operation-details";
import {
  createContext,
  useContext,
  useSyncExternalStore,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import {
  type WalletGateway,
  type TransactionIntent,
  type PreparedOperation,
  type TransactionRecord,
} from "@ewallet/domain";
import { Button, Modal, Notice } from "@ewallet/ui";
const Context = createContext<null | {
  gateway: WalletGateway;
  review: (intent: TransactionIntent) => Promise<TransactionRecord | null>;
  notify: (message: string) => void;
}>(null);
export function WalletProvider({
  gateway,
  children,
}: {
  gateway: WalletGateway;
  children: ReactNode;
}) {
  const [prepared, setPrepared] = useState<PreparedOperation | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [resolver, setResolver] = useState<{
    resolve: (record: TransactionRecord | null) => void;
  } | null>(null);
  const state = useSyncExternalStore(gateway.subscribe, gateway.getSnapshot);
  useEffect(() => {
    if (state.notification)
      setMessage(
        `Transaction ${state.notification.hash.slice(0, 12)}… ${state.notification.state}.`,
      );
  }, [state.notification]);
  useEffect(() => {
    if (state.locked && prepared) {
      gateway.reject(prepared.id);
      resolver?.resolve(null);
      setPrepared(null);
      setResolver(null);
      setBusy(false);
      setError("");
    }
  }, [state.locked, prepared, resolver, gateway]);
  async function review(intent: TransactionIntent) {
    if (prepared) throw new Error("Finish the current review first.");
    const op = await gateway.prepare(intent);
    setError("");
    setPrepared(op);
    return new Promise<TransactionRecord | null>((resolve) =>
      setResolver({ resolve }),
    );
  }
  function close() {
    if (busy) return;
    if (prepared) gateway.reject(prepared.id);
    resolver?.resolve(null);
    setPrepared(null);
    setResolver(null);
    setError("");
  }
  async function approve() {
    if (!prepared || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await gateway.approve(prepared.id, prepared.digest);
      resolver?.resolve(result);
      setPrepared(null);
      setResolver(null);
      setMessage(
        result.state === "confirmed"
          ? `${state.mode === "mock" ? "Sample operation" : "Operation"} confirmed.`
          : `${state.mode === "mock" ? "Sample operation" : "Operation"} ${result.state}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Context.Provider value={{ gateway, review, notify: setMessage }}>
      {children}
      {message && (
        <div className="toast" role="status">
          <span>{message}</span>
          <Button
            variant="ghost"
            aria-label="Dismiss notification"
            onClick={() => setMessage("")}
          >
            Dismiss
          </Button>
        </div>
      )}
      <Modal
        open={Boolean(prepared)}
        onClose={close}
        title="Review operation"
        description="Check the full recipient, selected network, amount and maximum fee before approving."
      >
        {prepared && (
          <>
            <Notice tone="warning">
              {state.mode === "mock"
                ? "Fixture preview · No real signature or funds"
                : "Test-network operation · Signed locally after approval"}
            </Notice>
            <OperationDetails operation={prepared} />
            {prepared.intent.origin && (
              <Notice>Request from {prepared.intent.origin}</Notice>
            )}
            {prepared.preview.warnings.map((w) => (
              <p className="muted" key={w}>
                {w}
              </p>
            ))}
            {error && <Notice tone="error">{error}</Notice>}
            <div className="form-actions">
              <Button variant="secondary" onClick={close} disabled={busy}>
                Reject
              </Button>
              <Button onClick={() => void approve()} disabled={busy}>
                {busy
                  ? "Submitting…"
                  : state.mode === "mock"
                    ? "Approve sample operation"
                    : "Approve operation"}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </Context.Provider>
  );
}
export function useWallet() {
  const c = useContext(Context);
  if (!c) throw new Error("Wallet context missing");
  const snapshot = useSyncExternalStore(
    c.gateway.subscribe,
    c.gateway.getSnapshot,
  );
  return { ...c, snapshot };
}
export function useAction() {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown> | unknown) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run };
}
