import { Link } from "react-router";
import { useState } from "react";
import { ArrowLeftRight, Droplets, Timer, Users, Route } from "lucide-react";
import {
  formatAmount,
  parseAmount,
  type TransactionIntent,
} from "@ewallet/domain";
import {
  Button,
  Empty,
  Field,
  Notice,
  PageTitle,
  Panel,
  Select,
  Address,
} from "@ewallet/ui";
import { useWallet, useAction } from "./context";

export function Services() {
  return (
    <>
      <PageTitle
        title="Contract services"
        description="Learn by doing with local test tokens. All values and operations here are fixtures."
      />
      <div className="service-grid">
        {[
          {
            path: "faucet",
            title: "Test faucet",
            text: "Request demo tokens. Practice without buying assets.",
            icon: Droplets,
          },
          {
            path: "vault",
            title: "Savings vault",
            text: "Lock principal for a fixed duration. No yield or returns.",
            icon: Timer,
          },
          {
            path: "shared",
            title: "Shared wallet",
            text: "Two of three independent owners approve an operation.",
            icon: Users,
          },
          {
            path: "swap",
            title: "Token swap",
            text: "Review an exact approval, quote and minimum received.",
            icon: ArrowLeftRight,
          },
          {
            path: "bridge",
            title: "Bridge simulation",
            text: "Two local chains and a trusted educational relayer.",
            icon: Route,
          },
        ].map(({ path, title, text, icon: Icon }) => (
          <Link className="service" to={`/${path}`} key={path}>
            <Icon size={26} />
            <h2>{title}</h2>
            <p className="muted">{text}</p>
            <span className="text-link">Open {title.toLowerCase()} →</span>
          </Link>
        ))}
      </div>
    </>
  );
}
function useService() {
  const w = useWallet(),
    action = useAction();
  const token = w.snapshot.balances.find((b) => b.symbol === "dUSDC");
  async function send(
    kind: TransactionIntent["kind"],
    amount: string,
    parameters?: Record<string, string>,
    recipient = "0x9999999999999999999999999999999999999999",
  ) {
    if (!token) throw new Error("Select Local Ethereum with demo tokens.");
    return w.review({
      requestId: crypto.randomUUID(),
      accountId: w.snapshot.selectedAccountId,
      networkId: w.snapshot.networkId,
      kind,
      recipient,
      asset: token.asset,
      amount,
      parameters,
    });
  }
  return { ...w, action, token, send };
}
function LocalOnly({ children }: { children: React.ReactNode }) {
  const { snapshot: s, gateway } = useWallet();
  if (s.networkId !== "eip155:31337")
    return (
      <>
        <PageTitle title="Local contract services" />
        <Notice tone="warning">
          These educational services use Local Ethereum only.
        </Notice>
        <Button onClick={() => gateway.selectNetwork("eip155:31337")}>
          Select Local Ethereum
        </Button>
      </>
    );
  return children;
}
export function Faucet() {
  const { send, action } = useService(),
    [receipt, setReceipt] = useState("");
  return (
    <LocalOnly>
      <PageTitle
        title="Test faucet"
        description="Request 100 dUSDC sample tokens. A 60-second cooldown applies."
      />
      <Panel>
        <Droplets size={32} className="mint" />
        <h2>A starting point for your next test</h2>
        <p className="muted">
          Local test tokens have no cash value. Public faucets are independent
          and may be unavailable.
        </p>
        <Button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              const r = await send("faucet", "100000000");
              if (r) setReceipt(r.state);
            })
          }
        >
          Review sample faucet claim
        </Button>
        {receipt && <Notice tone="success">Fixture claim: {receipt}</Notice>}
        {action.error && <Notice tone="error">{action.error}</Notice>}
      </Panel>
    </LocalOnly>
  );
}
export function Swap() {
  const { gateway, send, action } = useService();
  const [amount, setAmount] = useState("100"),
    [slippage, setSlippage] = useState("50"),
    [quote, setQuote] = useState<{
      output: string;
      minimum: string;
      expiresAt: number;
    } | null>(null),
    [approved, setApproved] = useState("");
  return (
    <LocalOnly>
      <PageTitle
        title="Swap test tokens"
        description="Demo dUSDC → dDAI · Constant-product pool · 0.30% swap fee"
      />
      <Panel className="narrow-panel">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              setQuote(await gateway.quote(amount, slippage));
            });
          }}
        >
          <Field
            label="You pay (dUSDC, 6 decimals)"
            value={amount}
            inputMode="decimal"
            onChange={(e) => {
              setAmount(e.target.value);
              setQuote(null);
            }}
          />
          <Select
            label="Slippage tolerance"
            value={slippage}
            onChange={(e) => {
              setSlippage(e.target.value);
              setQuote(null);
            }}
          >
            <option value="50">0.5%</option>
            <option value="100">1%</option>
            <option value="500">5% maximum</option>
          </Select>
          <Button type="submit" variant="secondary" disabled={action.busy}>
            Get sample quote
          </Button>
        </form>
        {quote && (
          <>
            <dl className="details">
              <dt>Estimated output</dt>
              <dd>{formatAmount(quote.output, 18)} dDAI</dd>
              <dt>Minimum received</dt>
              <dd>{formatAmount(quote.minimum, 18)} dDAI</dd>
              <dt>Quote expiry</dt>
              <dd>{new Date(quote.expiresAt).toLocaleTimeString()}</dd>
              <dt>Price impact</dt>
              <dd>Computed from fixture reserves; rounded down</dd>
              <dt>Data source</dt>
              <dd>Fixture · Synthetic demo valuation only</dd>
            </dl>
            <Notice>
              Exact allowance and swap each require approval. Quotes refresh
              after the allowance step.
            </Notice>
            <div className="form-actions">
              <Button
                variant="secondary"
                disabled={action.busy || approved === amount}
                onClick={() =>
                  void action.run(async () => {
                    const r = await send(
                      "approve",
                      parseAmount(amount, 6).toString(),
                      { spender: "0x9999999999999999999999999999999999999999" },
                    );
                    if (r?.state === "confirmed") {
                      setApproved(amount);
                      setQuote(await gateway.quote(amount, slippage));
                    }
                  })
                }
              >
                {approved === amount
                  ? "Exact sample allowance ready"
                  : "Review exact allowance"}
              </Button>
              <Button
                disabled={action.busy || approved !== amount}
                onClick={() =>
                  void action.run(async () => {
                    const r = await send(
                      "swap",
                      parseAmount(amount, 6).toString(),
                      {
                        minimum: quote.minimum,
                        output: quote.output,
                        quoteExpiry: String(quote.expiresAt),
                        deadline: String(Date.now() + 300000),
                      },
                    );
                    if (r) {
                      setQuote(null);
                      setApproved("");
                    }
                  })
                }
              >
                Review swap
              </Button>
            </div>
          </>
        )}
        {action.error && <Notice tone="error">{action.error}</Notice>}
      </Panel>
    </LocalOnly>
  );
}
export function Bridge() {
  const { send, action } = useService();
  const [amount, setAmount] = useState("25"),
    [stage, setStage] = useState<"draft" | "waiting" | "timeout" | "minted">(
      "draft",
    );
  return (
    <LocalOnly>
      <PageTitle title="Bridge simulation" />
      <Notice tone="warning">
        Bridge simulation — local test tokens only.
      </Notice>
      <Panel className="narrow-panel">
        <h2>Local Ethereum → Local bridge destination</h2>
        <p className="muted">
          The educational relayer is a trusted component. This demonstrates a
          lock/mint sequence, with no decentralized bridge or refund guarantee.
        </p>
        <Field
          label="Amount (dUSDC → bdUSDC)"
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
          disabled={stage !== "draft"}
        />
        <ol className="timeline">
          <li>
            Source lock{" "}
            {stage === "draft" ? "· waiting for review" : "· fixture confirmed"}
          </li>
          <li>
            Trusted sample relayer ·{" "}
            {stage === "minted"
              ? "processed"
              : stage === "timeout"
                ? "timed out"
                : "waiting"}
          </li>
          <li>
            Destination mint ·{" "}
            {stage === "minted" ? "fixture complete" : "not observed"}
          </li>
        </ol>
        {stage === "draft" ? (
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const r = await send(
                  "bridge",
                  parseAmount(amount, 6).toString(),
                  { destination: "eip155:31338" },
                );
                if (r?.state === "confirmed") setStage("waiting");
              })
            }
          >
            Review source lock
          </Button>
        ) : stage === "minted" ? (
          <Notice tone="success">
            Sample destination mint completed. This is a fixture state, not a
            chain receipt.
          </Notice>
        ) : (
          <>
            <div className="form-actions">
              <Button onClick={() => setStage("minted")}>
                {stage === "timeout"
                  ? "Retry sample relayer"
                  : "Run sample relayer"}
              </Button>
              <Button variant="secondary" onClick={() => setStage("timeout")}>
                Preview relayer timeout
              </Button>
            </div>
            {stage === "timeout" && (
              <Notice tone="warning">
                Locked in simulation; resume relayer or reset local demo. No
                automatic refund.
              </Notice>
            )}
          </>
        )}
        {action.error && <Notice tone="error">{action.error}</Notice>}
      </Panel>
    </LocalOnly>
  );
}
export function SavingsVault() {
  const { snapshot: s, send, action } = useService();
  const [amount, setAmount] = useState("100"),
    [duration, setDuration] = useState("60");
  return (
    <LocalOnly>
      <PageTitle
        title="Savings vault"
        description="A time lock on principal. No interest or promised returns."
      />
      <div className="content-grid">
        <Panel>
          <h2>Create position</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(() =>
                send("deposit", parseAmount(amount, 6).toString(), {
                  duration,
                }),
              );
            }}
          >
            <Field
              label="Deposit (dUSDC)"
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
            />
            <Select
              label="Lock duration"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            >
              <option value="60">60 seconds</option>
              <option value="300">5 minutes</option>
              <option value="3600">1 hour</option>
            </Select>
            <Notice>
              Phase 1 uses sample time. Real withdrawal eligibility must use
              chain time.
            </Notice>
            <Button type="submit" disabled={action.busy}>
              Review deposit
            </Button>
          </form>
        </Panel>
        <Panel>
          <h2>Your positions</h2>
          {s.positions.map((p) => (
            <div className="position" key={p.id}>
              <strong>{formatAmount(p.amount, 6)} dUSDC</strong>
              <p className="muted">
                {p.withdrawn
                  ? "Withdrawn"
                  : p.unlockAt > Date.now()
                    ? `Sample unlock: ${new Date(p.unlockAt).toLocaleTimeString()}`
                    : "Sample position withdrawable"}
              </p>
              <Button
                variant="secondary"
                disabled={p.withdrawn || p.unlockAt > Date.now() || action.busy}
                onClick={() =>
                  void action.run(() =>
                    send("withdraw", p.amount, { positionId: p.id }),
                  )
                }
              >
                Review withdrawal
              </Button>
            </div>
          ))}
          {!s.positions.length && (
            <Empty title="No vault positions">Your deposits appear here.</Empty>
          )}
        </Panel>
      </div>
      {action.error && <Notice tone="error">{action.error}</Notice>}
    </LocalOnly>
  );
}
export function SharedWallet() {
  const { snapshot: s, send, action } = useService();
  const [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState("25"),
    [owner, setOwner] = useState("Bob");
  return (
    <LocalOnly>
      <PageTitle
        title="Shared wallet"
        description="Exactly two of three distinct owners must approve. Separate roots are required for real custody."
      />
      <Notice tone="warning">
        Fixture owners Alice, Bob and Carol. Owner switching below is a mock
        control; it cannot authorize real transactions.
      </Notice>
      <div className="content-grid">
        <Panel>
          <h2>Create proposal</h2>
          <p className="muted">Sample holdings: 1 ETH · 1,000 dUSDC</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(() =>
                send(
                  "propose",
                  parseAmount(amount, 6).toString(),
                  undefined,
                  recipient,
                ),
              );
            }}
          >
            <Field
              label="Recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <Field
              label="Amount (dUSDC)"
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
            />
            <Button type="submit" disabled={action.busy}>
              Review proposal
            </Button>
          </form>
          <Select
            label="Sample owner for approvals"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            {["Alice", "Bob", "Carol"].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        </Panel>
        <Panel>
          <h2>Proposals</h2>
          {s.proposals.map((p) => (
            <div className="position" key={p.id}>
              <strong>{formatAmount(p.amount, 6)} dUSDC</strong>
              <Address value={p.recipient} />
              <p className="muted">
                {p.executed
                  ? "Executed"
                  : `${p.approvals.length} / 2 approvals · ${p.approvals.join(", ") || "None"}`}
              </p>
              <div className="form-actions">
                <Button
                  variant="secondary"
                  disabled={
                    p.executed || p.approvals.includes(owner) || action.busy
                  }
                  onClick={() =>
                    void action.run(() =>
                      send("multisig-approve", p.amount, {
                        proposalId: p.id,
                        owner,
                      }),
                    )
                  }
                >
                  Approve as {owner}
                </Button>
                <Button
                  variant="ghost"
                  disabled={
                    p.executed || !p.approvals.includes(owner) || action.busy
                  }
                  onClick={() =>
                    void action.run(() =>
                      send("multisig-revoke", p.amount, {
                        proposalId: p.id,
                        owner,
                      }),
                    )
                  }
                >
                  Revoke
                </Button>
                <Button
                  disabled={p.executed || p.approvals.length < 2 || action.busy}
                  onClick={() =>
                    void action.run(() =>
                      send("execute", p.amount, { proposalId: p.id }),
                    )
                  }
                >
                  Execute
                </Button>
              </div>
            </div>
          ))}
        </Panel>
      </div>
      {action.error && <Notice tone="error">{action.error}</Notice>}
    </LocalOnly>
  );
}
