import { Link, useNavigate, useSearchParams } from "react-router";
import { useState } from "react";
import {
  ArrowUpRight,
  ArrowDownLeft,
  ArrowLeftRight,
  Eye,
  EyeOff,
  RefreshCw,
  Plus,
  ChevronRight,
  ShieldCheck,
  ImageOff,
} from "lucide-react";
import {
  assetKey,
  formatAmount,
  formatUsd,
  demoValue,
  parseAmount,
  type AssetBalance,
} from "@ewallet/domain";
import { networkById } from "@ewallet/config";
import {
  Address,
  Button,
  Empty,
  Field,
  Notice,
  PageTitle,
  Panel,
  Select,
} from "@ewallet/ui";
import { useWallet, useAction } from "./context";

export function Coin({ symbol }: { symbol: string }) {
  return (
    <span aria-hidden="true" className={`coin coin-${symbol.toLowerCase()}`}>
      {symbol === "ETH"
        ? "Ξ"
        : symbol === "BTC"
          ? "₿"
          : symbol === "SOL"
            ? "◎"
            : symbol === "dUSDC"
              ? "$"
              : symbol.slice(0, 1)}
    </span>
  );
}
function BalanceRows({ balances }: { balances: AssetBalance[] }) {
  const { snapshot: s } = useWallet();
  return (
    <div className="asset-list">
      {balances.map((b) => (
        <Link
          className="asset-row"
          key={assetKey(b.asset)}
          to={`/asset?key=${encodeURIComponent(assetKey(b.asset))}`}
        >
          <Coin symbol={b.symbol} />
          <div className="asset-name">
            <strong>{b.symbol}</strong>
            <small>
              {b.name}
              {!b.verified ? " · Unverified" : ""}
            </small>
          </div>
          <div className="asset-quantity">
            <strong title={`${b.raw} base units`}>
              {s.hiddenAmounts ? "••••" : formatAmount(b.raw, b.decimals)}
            </strong>
            <small>
              {b.microUsdRate === null
                ? "Unpriced"
                : s.hiddenAmounts
                  ? "••••"
                  : formatUsd(demoValue([b]).microUsd)}
            </small>
          </div>
          <ChevronRight size={17} />
        </Link>
      ))}
    </div>
  );
}
export function Home() {
  const [watchAcknowledged, setWatchAcknowledged] = useState(false);
  const { snapshot: s, gateway, notify } = useWallet(),
    action = useAction();
  const n = networkById(s.networkId),
    value = demoValue(s.balances);
  const assets = s.balances.filter((b) => !b.hidden);
  return (
    <>
      <PageTitle
        title="Your wallet"
        description="A clear view of your digital assets."
        action={
          <Button
            variant="ghost"
            aria-label="Refresh balances"
            onClick={() =>
              void action.run(async () => {
                await gateway.refresh();
                notify(
                  s.mode === "mock"
                    ? "Sample balances refreshed."
                    : "Node balances refreshed.",
                );
              })
            }
          >
            <RefreshCw size={18} />
            <span className="desktop-label">Refresh</span>
          </Button>
        }
      />
      {s.mode !== "mock" &&
        n.family === "bitcoin" &&
        s.bitcoinWatchConsentRequired && (
          <Panel>
            <h2>Enable watch-only discovery</h2>
            <p>
              The configured local backend receives this account’s public ranged
              descriptors. They reveal current and future receive/change
              addresses and their activity. The backend uses a watch-only
              Bitcoin Core wallet; private keys stay in this browser’s Worker.
            </p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={watchAcknowledged}
                onChange={(e) => setWatchAcknowledged(e.target.checked)}
              />
              I understand that public descriptors reveal this account’s address
              activity.
            </label>
            <Button
              disabled={!watchAcknowledged || action.busy}
              onClick={() =>
                void action.run(async () => {
                  await gateway.connectBitcoinWatch?.();
                  setWatchAcknowledged(false);
                })
              }
            >
              Enable public descriptor watch
            </Button>
            {action.error && <Notice tone="error">{action.error}</Notice>}
          </Panel>
        )}
      {s.scenario === "rpc-offline" && (
        <Notice tone="error">
          Network disconnected. Last-known fixture data is shown; sending is
          unavailable.
        </Notice>
      )}
      {s.balances.some((b) => b.stale) && (
        <Notice tone="warning">
          Balances are stale. Refresh before preparing a payment.
        </Notice>
      )}
      <div className="overview-grid">
        <Panel className="balance-panel">
          <div className="section-heading">
            <span className="muted">Total demo value</span>
            <Button
              variant="ghost"
              aria-label={s.hiddenAmounts ? "Show amounts" : "Hide amounts"}
              onClick={() => gateway.toggleAmounts()}
            >
              {s.hiddenAmounts ? <EyeOff size={18} /> : <Eye size={18} />}
            </Button>
          </div>
          <div className="total">
            {s.balanceStatus === "unavailable"
              ? "Unavailable"
              : s.hiddenAmounts
                ? "••••••"
                : formatUsd(value.microUsd)}
          </div>
          <p className="muted">
            Synthetic prices · {n.name}
            {value.missingPriceCount > 0 ? " · Partial valuation" : ""}
          </p>
          <div className="quick-actions">
            <Link to="/send">
              <span>
                <ArrowUpRight />
              </span>
              Send
            </Link>
            <Link to="/receive">
              <span>
                <ArrowDownLeft />
              </span>
              Receive
            </Link>
            <Link to="/swap">
              <span>
                <ArrowLeftRight />
              </span>
              Swap
            </Link>
            <Link to="/services">
              <span>
                <ShieldCheck />
              </span>
              Services
            </Link>
          </div>
        </Panel>
        <Panel className="wallet-note">
          <ShieldCheck size={28} />
          <h2>
            Small steps.
            <br />
            More confidence.
          </h2>
          <p className="muted">
            Explore self-custody with sample assets before using a real
            test-network wallet.
          </p>
          <Link className="text-link" to="/evaluation">
            View evaluation status <ArrowUpRight size={17} />
          </Link>
        </Panel>
      </div>
      <div className="tabs">
        <Link className="active" to="/">
          Assets
        </Link>
        <Link to="/collectibles">Collectibles</Link>
        <Link to="/activity">Activity</Link>
        <Link to="/apps">Apps</Link>
      </div>
      <Panel>
        <div className="section-heading">
          <h2>
            Your assets <span className="count">{assets.length}</span>
          </h2>
          <Link className="text-link" to="/tokens">
            <Plus size={16} /> Manage tokens
          </Link>
        </div>
        {s.scenario === "loading" ? (
          <div className="empty" role="status">
            Loading sample balances…
          </div>
        ) : assets.length ? (
          <BalanceRows balances={assets} />
        ) : (
          <Empty title="No observed assets yet">
            {s.mode === "mock"
              ? "Receive test assets or visit the sample faucet to get started."
              : "Chain data is currently unavailable. This is not a confirmed zero balance."}
            <br />
            <Link className="text-link" to="/faucet">
              Open faucet
            </Link>
          </Empty>
        )}
        <p className="footnote">
          {s.source === "fixture" ? "Fixture data" : "Node data unavailable"} ·
          Updated{" "}
          {s.balanceStatus === "unavailable"
            ? "No observation yet"
            : new Date(s.updatedAt).toLocaleTimeString()}{" "}
          · Prices are educational examples.
        </p>
      </Panel>
      {action.error && <Notice tone="error">{action.error}</Notice>}
    </>
  );
}
export function AssetDetails() {
  const { snapshot: s, gateway } = useWallet();
  const [params] = useSearchParams();
  const b = s.balances.find((b) => assetKey(b.asset) === params.get("key"));
  if (!b)
    return (
      <Empty title="Asset not found">
        <Link to="/">Return to wallet</Link>
      </Empty>
    );
  return (
    <>
      <PageTitle
        title={b.name}
        description={`${b.symbol} · ${networkById(b.asset.networkId).name}`}
      />
      <Panel>
        <Coin symbol={b.symbol} />
        <h2 className="asset-total">
          {formatAmount(b.raw, b.decimals)} {b.symbol}
        </h2>
        <dl className="details">
          <dt>Identifier</dt>
          <dd>
            <Address value={b.asset.reference} />
          </dd>
          <dt>Decimals</dt>
          <dd>{b.decimals}</dd>
          <dt>Raw balance</dt>
          <dd className="break">{b.raw}</dd>
          <dt>Available / Reserved</dt>
          <dd className="break">
            {b.available} / {b.reserved}
          </dd>
          <dt>Source</dt>
          <dd>Fixture · observation {b.observation.observedHeight}</dd>
        </dl>
        <div className="form-actions">
          <Link
            className="button primary"
            to={`/send?asset=${encodeURIComponent(assetKey(b.asset))}`}
          >
            Send
          </Link>
          <Link className="button secondary" to="/receive">
            Receive
          </Link>
          <Button
            variant="ghost"
            onClick={() => gateway.hideAsset(assetKey(b.asset), !b.hidden)}
          >
            {b.hidden ? "Unhide asset" : "Hide asset"}
          </Button>
        </div>
      </Panel>
      <h2 className="subheading">Related activity</h2>
      <ActivityList asset={assetKey(b.asset)} />
    </>
  );
}
export function TokenManagement() {
  const { snapshot: s, gateway } = useWallet();
  const action = useAction(),
    [search, setSearch] = useState(""),
    [reference, setReference] = useState(""),
    [symbol, setSymbol] = useState(""),
    [decimals, setDecimals] = useState("6"),
    [ack, setAck] = useState(false);
  return (
    <>
      <PageTitle
        title="Manage tokens"
        description="Asset identity comes from its network and contract, never its ticker alone."
      />
      <Panel>
        <Field
          label="Search registry and imported assets"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {s.balances
          .filter((b) =>
            `${b.name} ${b.symbol}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((b) => (
            <div className="token-row" key={assetKey(b.asset)}>
              <Coin symbol={b.symbol} />
              <div>
                <strong>{b.symbol}</strong>
                <small className="muted block">
                  {b.verified
                    ? "Registry sample"
                    : "Unverified / possible spam"}
                </small>
              </div>
              <Button
                variant="secondary"
                onClick={() => gateway.hideAsset(assetKey(b.asset), !b.hidden)}
              >
                {b.hidden ? "Unhide" : "Hide"}
              </Button>
            </div>
          ))}
      </Panel>
      <Panel>
        <h2>Import custom token</h2>
        <Notice tone="warning">
          Mock metadata review only. A readable symbol is not proof of trust.
        </Notice>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              if (!ack)
                throw new Error("Review and acknowledge the token metadata.");
              await gateway.importToken(reference, symbol, Number(decimals));
              setReference("");
              setSymbol("");
              setAck(false);
            });
          }}
        >
          <Field
            label="Contract or mint address"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            spellCheck={false}
          />
          <div className="form-grid">
            <Field
              label="Sample symbol"
              value={symbol}
              maxLength={30}
              onChange={(e) => setSymbol(e.target.value)}
            />
            <Field
              label="Decimals"
              inputMode="numeric"
              value={decimals}
              onChange={(e) => setDecimals(e.target.value)}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />{" "}
            I reviewed the identifier and metadata on{" "}
            {networkById(s.networkId).name}.
          </label>
          {action.error && <Notice tone="error">{action.error}</Notice>}
          <Button type="submit" disabled={action.busy}>
            Import sample token
          </Button>
        </form>
      </Panel>
    </>
  );
}
export function ActivityList({ asset }: { asset?: string }) {
  const { snapshot: s, gateway } = useWallet(),
    [status, setStatus] = useState("all"),
    [kind, setKind] = useState("all"),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string | null>(null);
  const filtered = s.activity.filter(
    (t) =>
      t.networkId === s.networkId &&
      t.intent.accountId === s.selectedAccountId &&
      (!asset || assetKey(t.intent.asset) === asset) &&
      (status === "all" || t.state === status) &&
      (kind === "all" || t.intent.kind === kind),
  );
  const record = s.activity.find((t) => t.id === selected);
  return (
    <>
      {s.mode !== "mock" && s.history && (
        <Notice>
          {s.history.status === "syncing"
            ? "Activity indexing is in progress."
            : s.history.status === "unavailable"
              ? "Indexed activity is unavailable; journal entries remain visible."
              : `Indexed through ${s.history.observedHeight ?? "unknown height"}.`}{" "}
          {s.history.coverage}
          {s.history.hasMore && (
            <Button
              variant="secondary"
              onClick={() => void gateway.loadOlderActivity?.()}
            >
              Load older activity
            </Button>
          )}
        </Notice>
      )}
      <div className="filters">
        <Select
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">All statuses</option>
          {["confirmed", "submitted", "reverted"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </Select>
        <Select
          label="Operation"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">All operations</option>
          {Array.from(new Set(s.activity.map((t) => t.intent.kind))).map(
            (x) => (
              <option key={x}>{x}</option>
            ),
          )}
        </Select>
      </div>
      <Panel>
        {filtered.length ? (
          filtered.slice((page - 1) * 5, page * 5).map((t) => (
            <button
              className="activity-row"
              key={t.id}
              onClick={() => setSelected(t.id)}
            >
              <span className="activity-icon">
                {t.direction === "incoming" ? (
                  <ArrowDownLeft size={20} />
                ) : (
                  <ArrowUpRight size={20} />
                )}
              </span>
              <span>
                <strong>
                  {t.direction === "incoming"
                    ? "Received"
                    : t.intent.kind.replaceAll("-", " ")}
                </strong>
                <small>{new Date(t.createdAt).toLocaleString()}</small>
              </span>
              <span
                className={`badge ${t.state === "reverted" ? "danger" : ""}`}
              >
                {t.state}
              </span>
            </button>
          ))
        ) : (
          <Empty title="A fresh start">
            Your transactions will appear here after you approve an operation.
          </Empty>
        )}
        {filtered.length > 5 && (
          <div className="form-actions">
            <Button
              variant="secondary"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span>Page {page}</span>
            <Button
              variant="secondary"
              disabled={page * 5 >= filtered.length}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </Panel>
      {record && (
        <Panel>
          <div className="section-heading">
            <h2>Transaction details</h2>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Close details
            </Button>
          </div>
          <dl className="details">
            <dt>Status</dt>
            <dd>{record.state}</dd>
            <dt>Identifier</dt>
            <dd>
              <Address value={record.hash ?? record.id} />
            </dd>
            <dt>Full recipient</dt>
            <dd>
              <Address value={record.intent.recipient} />
            </dd>
            <dt>Amount (base units)</dt>
            <dd>{record.intent.amount}</dd>
            <dt>Network fee (base units)</dt>
            <dd>{record.fee ?? "Not observed yet"}</dd>
            <dt>Observation</dt>
            <dd>{record.height ?? "Not included"}</dd>
            <dt>Data source</dt>
            <dd>
              {record.source === "fixture"
                ? "Fixture · no explorer transaction exists"
                : "Node · inclusion thresholds are application policy"}
            </dd>
          </dl>
        </Panel>
      )}
    </>
  );
}
export function Activity() {
  return (
    <>
      <PageTitle
        title="Activity"
        description="Review transactions for the selected account and network."
      />
      <ActivityList />
    </>
  );
}
export function Collectibles() {
  const { snapshot: s, review, gateway } = useWallet(),
    action = useAction(),
    [selected, setSelected] = useState(""),
    [recipient, setRecipient] = useState(""),
    [quantity, setQuantity] = useState("1");
  const c = s.collectibles.find((c) => c.id === selected);
  return (
    <>
      <PageTitle
        title="Collectibles"
        description="Ownership, quantities and metadata stay separate."
      />
      <div className="collectible-grid">
        {s.collectibles.map((c) => (
          <button
            className="collectible"
            key={c.id}
            onClick={() => setSelected(c.id)}
          >
            <div className="collectible-art">
              {c.image ? (
                <img src={c.image} alt="Original Campus Pass artwork" />
              ) : (
                <>
                  <ImageOff size={40} />
                  <span>Media unavailable</span>
                </>
              )}
            </div>
            <div>
              <h3>{c.name}</h3>
              <p className="muted">
                Quantity {c.quantity} ·{" "}
                {c.metadataStatus === "safe"
                  ? "Local safe media"
                  : "Metadata unavailable"}
              </p>
            </div>
          </button>
        ))}
      </div>
      {!s.collectibles.length && (
        <Empty title="No collectibles on this network">
          Bitcoin collectibles and compressed Solana NFTs are outside this
          build.
        </Empty>
      )}
      {c && (
        <Panel>
          <h2>{c.name}</h2>
          <Address value={c.asset.reference} />
          <p>
            Owned quantity: {c.quantity} · ID {c.asset.tokenId ?? "mint"}
          </p>
          {s.mode !== "mock" && (
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() =>
                void action.run(() => gateway.loadCollectibleMetadata?.(c.id))
              }
            >
              Load safe NFT details
            </Button>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const amount = parseAmount(quantity, 0);
                if (amount > BigInt(c.quantity))
                  throw new Error("Quantity exceeds ownership.");
                await review({
                  requestId: crypto.randomUUID(),
                  accountId: s.selectedAccountId,
                  networkId: s.networkId,
                  kind: "nft-transfer",
                  recipient,
                  asset: c.asset,
                  amount: amount.toString(),
                });
              });
            }}
          >
            <Field
              label="Full recipient address"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <Field
              label="Quantity"
              value={quantity}
              inputMode="numeric"
              onChange={(e) => setQuantity(e.target.value)}
            />
            {action.error && <Notice tone="error">{action.error}</Notice>}
            {c.transferable === false && (
              <Notice tone="warning">
                {c.unsupportedReason ??
                  "This collectible type is not transferable in this build."}
              </Notice>
            )}
            <Button
              type="submit"
              disabled={action.busy || c.transferable === false}
            >
              Review collectible transfer
            </Button>
          </form>
        </Panel>
      )}
    </>
  );
}
export function ConnectedApps() {
  const { snapshot: s, gateway, review } = useWallet(),
    action = useAction();
  const [revoked, setRevoked] = useState(false);
  const token = s.balances.find((b) => b.symbol === "dUSDC");
  return (
    <>
      <PageTitle
        title="Connected apps"
        description="A connection grant and an on-chain token allowance are different permissions."
      />
      <Panel>
        <h2>Connection grants</h2>
        {s.permissions
          .filter((p) => !p.revoked)
          .map((p) => (
            <div className="permission-row" key={p.id}>
              <div>
                <strong className="break">{p.origin}</strong>
                <p className="muted">{p.methods.join(", ")}</p>
                <p className="small muted">
                  {p.networks.join(", ")} · Expires{" "}
                  {new Date(p.expiresAt).toLocaleDateString()}
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => gateway.disconnect(p.id)}
              >
                Disconnect
              </Button>
            </div>
          ))}
        {s.permissions.every((p) => p.revoked) && (
          <Empty title="No connected apps">
            Only apps using the e-wallet connector can request access.
          </Empty>
        )}
        <Link className="text-link" to="/connect">
          Preview connection approval
        </Link>
      </Panel>
      <Panel>
        <h2>Token authorizations</h2>
        <p className="muted">
          Coverage is limited to the sample tracked range. Disconnecting does
          not revoke allowances.
        </p>
        {networkById(s.networkId).family === "bitcoin" ? (
          <Notice>Bitcoin requires approval for every signing request.</Notice>
        ) : token && !revoked ? (
          <div className="permission-row">
            <div>
              <strong>dUSDC · Sample spender</strong>
              <p>Exact allowance: 25 dUSDC</p>
              <Address value="0x8888888888888888888888888888888888888888" />
            </div>
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const tx = await review({
                    requestId: crypto.randomUUID(),
                    accountId: s.selectedAccountId,
                    networkId: s.networkId,
                    kind: "revoke",
                    recipient: "0x8888888888888888888888888888888888888888",
                    asset: token.asset,
                    amount: "1",
                  });
                  if (tx?.state === "confirmed") setRevoked(true);
                })
              }
            >
              Review revoke
            </Button>
          </div>
        ) : (
          <Notice>No tracked sample authorizations.</Notice>
        )}
        {action.error && <Notice tone="error">{action.error}</Notice>}
      </Panel>
    </>
  );
}
export function ConnectionApproval() {
  const { snapshot: s, gateway } = useWallet(),
    nav = useNavigate();
  const [result, setResult] = useState("");
  return (
    <div className="approval-page">
      <PageTitle
        title="Connection request"
        description="An app is asking to view your selected public account."
      />
      <Panel>
        <Notice tone="warning">Fixture connection preview</Notice>
        <h2>http://127.0.0.1:5174</h2>
        <p className="muted">
          This exact sample origin can request public addresses. Every signing
          request needs a separate review.
        </p>
        <dl className="details">
          <dt>Account</dt>
          <dd>{s.accounts.find((a) => a.id === s.selectedAccountId)?.name}</dd>
          <dt>Network</dt>
          <dd>{networkById(s.networkId).name}</dd>
          <dt>Methods</dt>
          <dd>View public account · Request transfer approval</dd>
          <dt>Grant duration</dt>
          <dd>24 hours</dd>
        </dl>
        {result ? (
          <Notice tone="success">{result}</Notice>
        ) : (
          <div className="form-actions">
            <Button
              variant="secondary"
              onClick={() => {
                setResult("Connection rejected. No account was shared.");
              }}
            >
              Reject connection
            </Button>
            <Button
              onClick={() => {
                setResult(
                  "Sample connection approved. Public account access only.",
                );
              }}
            >
              Allow sample connection
            </Button>
          </div>
        )}
        <div className="form-actions">
          <Button variant="ghost" onClick={() => nav("/apps")}>
            Back to apps
          </Button>
          <Button variant="ghost" onClick={() => gateway.lock()}>
            Lock wallet
          </Button>
        </div>
      </Panel>
    </div>
  );
}
