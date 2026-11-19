import { displayNetworkName } from "@ewallet/domain";
import { useEffect, useRef, useState } from "react";
import { networks, networkById } from "@ewallet/config";
import {
  type ConnectorRequest,
  type MessageReview,
  type PreparedOperation,
} from "@ewallet/domain";
import { Address, Button, Field, Notice } from "@ewallet/ui";
import { useWallet } from "./context";
import { RealWalletGateway } from "./real-gateway";
import { ConnectorHost } from "./connector-host";
import { OperationDetails } from "./operation-details";
const reads = [
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "solana:connect",
  "solana:accounts",
  "bitcoin:getAccounts",
  "bitcoin:getNetwork",
];
export function ConnectPage() {
  const { gateway, snapshot: s } = useWallet();
  const real = gateway instanceof RealWalletGateway ? gateway : null;
  const host = useRef<ConnectorHost | null>(null);
  const opened = useRef(false);
  const [incoming, setIncoming] = useState<{
    origin: string;
    request: ConnectorRequest;
  } | null>(null);
  const [watchConsent, setWatchConsent] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [live, setLive] = useState<{
    grantId: string;
    account: string;
    networkId: string;
    expiresAt: string;
  } | null>(null);
  const [prepared, setPrepared] = useState<
    | { kind: "transaction"; operation: PreparedOperation }
    | { kind: "message"; review: MessageReview }
    | null
  >(null);
  useEffect(() => {
    try {
      host.current = new ConnectorHost(
        (origin, request) => setIncoming({ origin, request }),
        setError,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Approval channel unavailable.",
      );
    }
    return () => {
      host.current?.dispose();
      host.current = null;
    };
  }, []);
  useEffect(() => {
    if (!real || !live) return;
    const interval = setInterval(() => {
      void real.pollConnector().catch(() => {
        host.current?.event("disconnect");
        setLive(null);
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [real, live]);
  useEffect(() => {
    if (!live) return;
    const grant = s.permissions.find((p) => p.id === live.grantId);
    if (
      s.locked ||
      !grant ||
      grant.revoked ||
      Date.parse(live.expiresAt) <= Date.now()
    ) {
      host.current?.event("disconnect");
      setLive(null);
      return;
    }
    const account = s.accounts.find((a) => a.id === s.selectedAccountId);
    if (s.networkId !== live.networkId || account?.address !== live.account) {
      // A grant is specific to the previously approved account and network.
      // Selection changes require a new consent rather than sharing another address.
      host.current?.event("accountsChanged", []);
      host.current?.event("disconnect");
      setLive(null);
    }
  }, [s, live]);
  useEffect(() => {
    if (!incoming || done) return;
    const timer = setTimeout(
      () => {
        host.current?.cancel("The two-minute request expired.");
        setDone(true);
      },
      Math.max(0, incoming.request.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [incoming, done]);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
  }
  async function open() {
    if (!real || !incoming) throw new Error("No bound requesting site.");
    await host.current!.verify();
    if (!opened.current) {
      await real.openConnector(incoming.origin, incoming.request);
      opened.current = true;
    }
  }
  async function consent() {
    if (!real || !incoming) return;
    await open();
    if (incoming.request.method === "disconnect") {
      host.current!.result(
        await real.disconnectConnector(incoming.request.channel),
      );
      setDone(true);
      return;
    }
    if (
      incoming.request.family === "bitcoin" &&
      incoming.request.method !== "disconnect"
    ) {
      if (!watchConsent)
        throw new Error(
          "Review the Bitcoin public descriptor disclosure first.",
        );
      await real.connectBitcoinWatch();
    }
    const grant = await real.grantConnector(incoming.request.channel);
    if (reads.includes(incoming.request.method)) {
      const result = await real.readConnector(incoming.request.channel);
      await host.current!.verify();
      host.current!.result(result, true);
      setDone(true);
      setLive({
        grantId: grant.id,
        account: s.accounts.find((a) => a.id === s.selectedAccountId)!.address,
        networkId: s.networkId,
        expiresAt: grant.expiresAt,
      });
    } else if (incoming.request.method === "wallet_switchEthereumChain") {
      const result = await real.switchConnector(incoming.request.channel);
      await host.current!.verify();
      host.current!.result(result);
      setDone(true);
    } else {
      setPrepared(await real.prepareConnector(incoming.request.channel));
    }
  }
  async function approve() {
    if (!real || !incoming || !prepared) return;
    await host.current!.verify();
    const result =
      prepared.kind === "message"
        ? await real.signConnectorMessage(
            incoming.request.channel,
            prepared.review.id,
            prepared.review.digest,
          )
        : await real.executeConnector(
            incoming.request.channel,
            prepared.operation.id,
            prepared.operation.digest,
          );
    host.current!.result(result);
    setPrepared(null);
    setDone(true);
  }
  function reject() {
    host.current?.cancel();
    if (prepared?.kind === "transaction") gateway.reject(prepared.operation.id);
    setDone(true);
    setPrepared(null);
  }
  const account = s.accounts.find((a) => a.id === s.selectedAccountId);
  return (
    <section className="connect-page">
      <p className="eyebrow">E-WALLET · SITE REQUEST</p>
      <h1>
        {prepared
          ? "Review site request"
          : done
            ? "Request completed"
            : "Connect a site"}
      </h1>
      {incoming && (
        <>
          <p>Requesting website</p>
          <p className="connector-origin" data-testid="request-origin">
            {incoming.origin}
          </p>
          <dl className="details">
            <dt>Requested family</dt>
            <dd>{incoming.request.family}</dd>
            <dt>Method</dt>
            <dd>{incoming.request.method}</dd>
            {incoming.request.method === "wallet_switchEthereumChain" && (
              <>
                <dt>Requested network</dt>
                <dd>{JSON.stringify(incoming.request.params)}</dd>
              </>
            )}
            <dt>Request ID</dt>
            <dd>{incoming.request.requestId}</dd>
          </dl>
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {!done && !s.initialized && (
        <Notice>
          Set up this browser wallet in a separate wallet tab, then make a fresh
          request from the site.
        </Notice>
      )}
      {!done && s.initialized && s.locked && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await real!.unlock(password);
              setPassword("");
            });
          }}
        >
          <p>
            Unlock this approval window. Each window has its own signing
            session.
          </p>
          <Field
            label="Wallet password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            Unlock approval window
          </Button>
        </form>
      )}
      {!done && !s.locked && incoming && !prepared && (
        <>
          <label>
            Network
            <select
              aria-label="Approval network"
              disabled={busy || opened.current}
              value={s.networkId}
              onChange={(e) => {
                void run(async () => {
                  await real!.selectConnectorNetwork(e.target.value);
                });
              }}
            >
              {networks
                .filter(
                  (n) =>
                    n.family === incoming.request.family &&
                    (n.environment === s.mode || n.family === "bitcoin"),
                )
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {displayNetworkName(n)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Account
            <select
              aria-label="Approval account"
              disabled={busy || opened.current}
              value={s.selectedAccountId}
              onChange={(e) => {
                void run(async () => {
                  await real!.selectConnectorAccount(e.target.value);
                });
              }}
            >
              {s.accounts
                .filter((a) => a.family === incoming.request.family)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.path}
                  </option>
                ))}
            </select>
          </label>
          <p>Selected signing account</p>
          {account && <Address value={account.address} />}
          <p>
            Grant: this origin, this account, {displayNetworkName(networkById(s.networkId))},
            and the requested supported methods. Expires in 24 hours. Every
            signing request needs a separate review.
          </p>
          {incoming.request.family === "bitcoin" && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={watchConsent}
                onChange={(e) => setWatchConsent(e.target.checked)}
              />{" "}
              I consent to watch-only discovery. Public descriptors reveal
              current and future address activity to this local backend; no
              private keys are shared.
            </label>
          )}
          <pre className="message-preview">
            {JSON.stringify(
              incoming.request.params[0] &&
                typeof incoming.request.params[0] === "object" &&
                "methods" in incoming.request.params[0]
                ? incoming.request.params[0].methods
                : [incoming.request.method],
              null,
              2,
            )}
          </pre>
          <Button
            disabled={busy || account?.family !== incoming.request.family}
            onClick={() => void run(consent)}
          >
            {reads.includes(incoming.request.method)
              ? "Approve connection"
              : incoming.request.method === "disconnect"
                ? "Disconnect site"
                : incoming.request.method === "wallet_switchEthereumChain"
                  ? "Approve network switch"
                  : "Review request"}
          </Button>
        </>
      )}
      {prepared?.kind === "transaction" && (
        <>
          <OperationDetails operation={prepared.operation} />
          {prepared.operation.preview.warnings.map((w) => (
            <Notice key={w} tone="warning">
              {w}
            </Notice>
          ))}
        </>
      )}
      {prepared?.kind === "message" && (
        <>
          <Notice tone="warning">
            A signature can authorize actions. Review the complete message and
            requesting origin.
          </Notice>
          <dl className="details">
            <dt>Network</dt>
            <dd>{displayNetworkName(networkById(prepared.review.networkId))}</dd>
            <dt>Signing account</dt>
            <dd>
              <Address value={prepared.review.accountAddress} />
            </dd>
            <dt>Encoding / size</dt>
            <dd>
              {prepared.review.encoding} · {prepared.review.byteLength} bytes
            </dd>
            {prepared.review.domain &&
              Object.entries(prepared.review.domain).map(([key, value]) => (
                <div className="detail-line" key={key}>
                  <dt>{key}</dt>
                  <dd>{value ?? "Not supplied"}</dd>
                </div>
              ))}
            <dt>Review expires</dt>
            <dd>{new Date(prepared.review.expiresAt).toISOString()}</dd>
          </dl>
          <pre className="message-preview" data-testid="message-review">
            {prepared.review.displayText}
          </pre>
        </>
      )}
      {prepared && (
        <Button disabled={busy || s.locked} onClick={() => void run(approve)}>
          {busy
            ? "Approving…"
            : prepared.kind === "message"
              ? "Approve signature"
              : "Approve operation"}
        </Button>
      )}
      {!done && (
        <Button variant="secondary" disabled={busy} onClick={reject}>
          Reject request
        </Button>
      )}
      {done && (
        <Notice>
          {live
            ? "Connected. Keep this window open to receive account, lock and disconnect events. You may close it to disconnect this session."
            : "You can close this window and return to the requesting website."}
        </Notice>
      )}
    </section>
  );
}
