import { z } from "zod";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  formatAmount,
  parseAmount,
  swapQuoteSchema,
  type ServiceState,
  type SwapQuote,
  type TransactionIntent,
} from "@ewallet/domain";
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

type Service = "faucet" | "swap" | "vault" | "shared" | "bridge";
export function RealServices() {
  return (
    <>
      <PageTitle
        title="Contract services"
        description="Manage tokens, allowances and contract operations."
      />
      <div className="service-grid">
        {[
          ["faucet", "Faucet", "Claim tokens within the available allowance."],
          [
            "swap",
            "Token swap",
            "A constant-product pool with a 0.30% swap fee.",
          ],
          [
            "vault",
            "Savings vault",
            "Lock principal for a fixed duration, with no yield.",
          ],
          [
            "shared",
            "Shared wallet",
            "Two independent owners must approve execution.",
          ],
          [
            "bridge",
            "Bridge",
            "Local lock and mint through a trusted CLI relayer.",
          ],
        ].map(([route, title, text]) => (
          <Link className="service" to={"/" + route} key={route}>
            <h2>{title}</h2>
            <p className="muted">{text}</p>
            <span className="text-link">Open service →</span>
          </Link>
        ))}
      </div>
    </>
  );
}
export function RealService({ service }: { service: Service }) {
  const { snapshot: s, gateway } = useWallet();
  const query = useQuery({
    queryKey: ["services", s.networkId, s.selectedAccountId],
    queryFn: () => {
      if (!gateway.loadServices)
        throw new Error("Service adapter unavailable.");
      return gateway.loadServices();
    },
    enabled: !s.locked && s.networkId === "eip155:31337",
    refetchInterval: 5000,
    retry: false,
  });
  if (s.networkId !== "eip155:31337")
    return (
      <>
        <PageTitle title="Local contract services" />
        <Notice>
          These configured contracts are deployed on Local Ethereum A.
        </Notice>
        <Button onClick={() => gateway.selectNetwork("eip155:31337")}>
          Select Local Ethereum
        </Button>
      </>
    );
  if (query.error)
    return (
      <>
        <PageTitle title="Contract state unavailable" />
        <Notice tone="error">{query.error.message}</Notice>
        <Button onClick={() => void query.refetch()}>
          Retry contract reads
        </Button>
      </>
    );
  if (!query.data) return <Notice>Reading verified contracts…</Notice>;
  return (
    <>
      <LiveService
        key={service + ":" + s.selectedAccountId}
        service={service}
        data={query.data}
      />
      <p className="muted">
        Node data · block {query.data.observedBlock} · observed{" "}
        {new Date(query.data.observedAt).toLocaleTimeString()}. Eligibility is
        checked again before signing.
      </p>
    </>
  );
}
function LiveService({
  service,
  data: d,
}: {
  service: Service;
  data: ServiceState;
}) {
  const { snapshot: s, gateway, review } = useWallet(),
    action = useAction(),
    cache = useQueryClient();
  const [amount, setAmount] = useState("25"),
    [duration, setDuration] = useState("60"),
    [slippage, setSlippage] = useState("50"),
    [recipient, setRecipient] = useState(""),
    [assetType, setAssetType] = useState("erc20"),
    [quote, setQuote] = useState<SwapQuote | null>(null),
    [receipt, setReceipt] = useState("");
  const bridge = useQuery({
    queryKey: ["bridge-observation", s.selectedAccountId],
    enabled: service === "bridge",
    queryFn: async () => {
      const response = await fetch("/api/v1/bridge/status", {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          "Bridge pair unavailable; verify nodes and run pnpm seed:local.",
        );
      return z
        .object({
          data: z.object({
            observedAt: z.string(),
            messages: z.array(
              z.object({
                id: z.string(),
                sender: z.string(),
                recipient: z.string(),
                amount: z.string(),
                sourceHash: z.string(),
                destinationHash: z.string().nullable(),
                state: z.enum(["waiting", "minted", "timeout"]),
              }),
            ),
          }),
        })
        .parse(await response.json()).data;
    },
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const asset = {
    networkId: s.networkId,
    standard: "erc20" as const,
    reference: d.token.reference.toLowerCase(),
  };
  async function send(
    kind: TransactionIntent["kind"],
    raw: string,
    to: string,
    parameters?: Record<string, string>,
    selectedAsset = asset as TransactionIntent["asset"],
  ) {
    const result = await review({
      requestId: crypto.randomUUID(),
      accountId: s.selectedAccountId,
      networkId: s.networkId,
      kind,
      recipient: to,
      asset: selectedAsset,
      amount: raw,
      parameters,
    });
    if (result)
      setReceipt(
        `${kind}: ${result.state}${result.hash ? " · " + result.hash : ""}`,
      );
    await cache.invalidateQueries({
      queryKey: ["services", s.networkId, s.selectedAccountId],
    });
    return result;
  }
  async function approveFor(spender: string, current: string) {
    const raw = parseAmount(amount, d.token.decimals).toString();
    return send(
      BigInt(current) > 0n && current !== raw ? "revoke" : "approve",
      BigInt(current) > 0n && current !== raw ? "0" : raw,
      spender,
    );
  }
  const input = (label = "Amount (dUSDC)") => (
    <Field
      label={label}
      value={amount}
      inputMode="decimal"
      onChange={(e) => {
        setAmount(e.target.value);
        setQuote(null);
      }}
    />
  );
  const isOwner = d.shared.owners.some(
    (o) => o.toLowerCase() === d.accountAddress.toLowerCase(),
  );
  return (
    <>
      <PageTitle
        title={
          {
            faucet: "Faucet",
            swap: "Swap tokens",
            vault: "Savings vault",
            shared: "Shared wallet",
            bridge: "Bridge",
          }[service]
        }
        description="Real local transactions require a separate review and signature."
      />
      {service === "faucet" && (
        <Panel className="narrow-panel">
          <h2>
            {formatAmount(d.faucet.amount, d.token.decimals)} {d.token.symbol}{" "}
            per claim
          </h2>
          <p>
            60-second cooldown · {d.faucet.claims} / {d.faucet.maximumClaims}{" "}
            claims used.
          </p>
          {BigInt(d.faucet.nextClaimAt) > BigInt(d.chainTimestamp) && (
            <Notice>
              Next eligible chain time:{" "}
              {new Date(
                Number(d.faucet.nextClaimAt) * 1000,
              ).toLocaleTimeString()}
            </Notice>
          )}
          <Button
            disabled={
              action.busy ||
              BigInt(d.faucet.nextClaimAt) > BigInt(d.chainTimestamp) ||
              BigInt(d.faucet.claims) >= BigInt(d.faucet.maximumClaims)
            }
            onClick={() =>
              void action.run(() =>
                send("faucet", d.faucet.amount, d.contracts.faucet),
              )
            }
          >
            Review faucet claim
          </Button>
        </Panel>
      )}
      {service === "swap" && (
        <Panel className="narrow-panel">
          <p>
            {d.token.symbol} → {d.outputToken.symbol} · 0.30% pool fee
          </p>
          {input()}
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
          <Button
            variant="secondary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () =>
                setQuote(
                  swapQuoteSchema.parse(await gateway.quote(amount, slippage)),
                ),
              )
            }
          >
            Get quote
          </Button>
          {quote && (
            <>
              <dl className="details">
                <dt>Estimated output</dt>
                <dd>
                  {formatAmount(quote.output, d.outputToken.decimals)}{" "}
                  {d.outputToken.symbol}
                </dd>
                <dt>Minimum received</dt>
                <dd>
                  {formatAmount(quote.minimum, d.outputToken.decimals)}{" "}
                  {d.outputToken.symbol}
                </dd>
                <dt>Price impact, excluding pool fee</dt>
                <dd>{formatAmount(quote.priceImpactBps, 2)}%</dd>
                <dt>Quote expires</dt>
                <dd>{new Date(quote.expiresAt).toLocaleTimeString()}</dd>
              </dl>
              <Notice>
                Quotes reflect pool reserves. After an allowance
                transaction, request a fresh quote.
              </Notice>
              <div className="form-actions">
                {BigInt(quote.allowance) < BigInt(quote.amountIn) && (
                  <Button
                    variant="secondary"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await approveFor(d.contracts.pool, quote.allowance);
                        setQuote(null);
                      })
                    }
                  >
                    {BigInt(quote.allowance) > 0n
                      ? "Review allowance reset"
                      : "Review exact allowance"}
                  </Button>
                )}
                <Button
                  disabled={
                    action.busy ||
                    BigInt(quote.allowance) < BigInt(quote.amountIn) ||
                    Date.now() >= quote.expiresAt
                  }
                  onClick={() =>
                    void action.run(async () => {
                      await send("swap", quote.amountIn, d.contracts.pool, {
                        quoteId: quote.quoteId,
                      });
                      setQuote(null);
                    })
                  }
                >
                  Review swap
                </Button>
              </div>
            </>
          )}
        </Panel>
      )}
      {service === "vault" && (
        <>
          <Notice>
            Principal only. No interest or returns. Eligibility uses chain time.
          </Notice>
          <div className="content-grid">
            <Panel>
              <h2>Create position</h2>
              {input("Deposit (dUSDC)")}
              <Select
                label="Lock duration"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              >
                <option value="60">60 seconds</option>
                <option value="300">5 minutes</option>
                <option value="3600">1 hour</option>
              </Select>
              <div className="form-actions">
                <Button
                  variant="secondary"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      approveFor(d.contracts.vault, d.allowances.vault),
                    )
                  }
                >
                  Review exact vault allowance
                </Button>
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      send(
                        "deposit",
                        parseAmount(amount, d.token.decimals).toString(),
                        d.contracts.vault,
                        { duration },
                      ),
                    )
                  }
                >
                  Review deposit
                </Button>
              </div>
            </Panel>
            <Panel>
              <h2>Your positions</h2>
              {d.positions.map((p) => (
                <div className="position" key={p.id}>
                  <strong>
                    Position #{p.id} ·{" "}
                    {formatAmount(p.amount, p.token.decimals)} {p.token.symbol}
                  </strong>
                  <p>
                    {p.withdrawn
                      ? "Withdrawn"
                      : BigInt(p.unlockAt) <= BigInt(d.chainTimestamp)
                        ? "Withdrawable"
                        : `Locked until ${new Date(Number(p.unlockAt) * 1000).toLocaleTimeString()}`}
                  </p>
                  <Button
                    variant="secondary"
                    disabled={
                      action.busy ||
                      p.withdrawn ||
                      BigInt(p.unlockAt) > BigInt(d.chainTimestamp)
                    }
                    onClick={() =>
                      void action.run(() =>
                        send(
                          "withdraw",
                          p.amount,
                          d.contracts.vault,
                          { positionId: p.id },
                          {
                            ...asset,
                            reference: p.token.reference.toLowerCase(),
                          },
                        ),
                      )
                    }
                  >
                    Review withdrawal #{p.id}
                  </Button>
                </div>
              ))}
              {!d.positions.length && (
                <Empty title="No vault positions">
                  Deposits appear after inclusion.
                </Empty>
              )}
            </Panel>
          </div>
        </>
      )}
      {service === "shared" && (
        <>
          <Notice>
            Two of three distinct owner addresses must approve. Each owner signs
            from their own wallet root and browser profile.
          </Notice>
          <Panel>
            <h2>Contract holdings</h2>
            <p>
              {formatAmount(d.shared.nativeBalance, 18)} ETH ·{" "}
              {formatAmount(d.shared.tokenBalance, d.token.decimals)}{" "}
              {d.token.symbol}
            </p>
            <Address value={d.contracts.shared} />
            <h3>Owners</h3>
            {d.shared.owners.map((o) => (
              <Address key={o} value={o} />
            ))}
            {!isOwner && (
              <Notice>
                This selected account is not an owner. Proposals and approvals
                require an owner.
              </Notice>
            )}
          </Panel>
          <div className="content-grid">
            <Panel>
              <h2>Create proposal</h2>
              <Select
                label="Proposal asset"
                value={assetType}
                onChange={(e) => setAssetType(e.target.value)}
              >
                <option value="erc20">dUSDC</option>
                <option value="native">ETH</option>
              </Select>
              <Field
                label="Proposal recipient"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              {input(
                assetType === "native"
                  ? "Proposal amount (ETH)"
                  : "Proposal amount (dUSDC)",
              )}
              <Button
                disabled={action.busy || !isOwner}
                onClick={() =>
                  void action.run(() =>
                    send(
                      "propose",
                      parseAmount(
                        amount,
                        assetType === "native" ? 18 : d.token.decimals,
                      ).toString(),
                      recipient,
                      undefined,
                      assetType === "native"
                        ? {
                            networkId: s.networkId,
                            standard: "native",
                            reference: "native",
                          }
                        : asset,
                    ),
                  )
                }
              >
                Review proposal
              </Button>
            </Panel>
            <Panel>
              <h2>Proposals</h2>
              {d.shared.proposals.map((p) => {
                const ownApproval = p.approvals.some(
                  (a) => a.toLowerCase() === d.accountAddress.toLowerCase(),
                );
                const proposalAsset: TransactionIntent["asset"] =
                  p.standard === "native"
                    ? {
                        networkId: s.networkId,
                        standard: "native",
                        reference: "native",
                      }
                    : {
                        ...asset,
                        reference: p.token?.reference.toLowerCase() ?? "",
                      };
                return (
                  <div className="position" key={p.id}>
                    <strong>
                      Proposal #{p.id} ·{" "}
                      {formatAmount(
                        p.amount,
                        p.standard === "native" ? 18 : (p.token?.decimals ?? 0),
                      )}{" "}
                      {p.standard === "native"
                        ? "ETH"
                        : (p.token?.symbol ?? "Unknown")}
                    </strong>
                    <Address value={p.recipient} />
                    <p>
                      {p.executed
                        ? "Executed"
                        : `${p.approvals.length} / 2 approvals`}
                    </p>
                    {!p.supported ? (
                      <Notice>
                        Unsupported target or calldata. Signing is unavailable.
                      </Notice>
                    ) : (
                      <div className="form-actions">
                        <Button
                          variant="secondary"
                          disabled={
                            action.busy || !isOwner || p.executed || ownApproval
                          }
                          onClick={() =>
                            void action.run(() =>
                              send(
                                "multisig-approve",
                                p.amount,
                                d.contracts.shared,
                                { proposalId: p.id },
                                proposalAsset,
                              ),
                            )
                          }
                        >
                          Review approval #{p.id}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={
                            action.busy ||
                            !isOwner ||
                            p.executed ||
                            !ownApproval
                          }
                          onClick={() =>
                            void action.run(() =>
                              send(
                                "multisig-revoke",
                                p.amount,
                                d.contracts.shared,
                                { proposalId: p.id },
                                proposalAsset,
                              ),
                            )
                          }
                        >
                          Review revoke #{p.id}
                        </Button>
                        <Button
                          disabled={
                            action.busy ||
                            !isOwner ||
                            p.executed ||
                            p.approvals.length < 2
                          }
                          onClick={() =>
                            void action.run(() =>
                              send(
                                "execute",
                                p.amount,
                                d.contracts.shared,
                                { proposalId: p.id },
                                proposalAsset,
                              ),
                            )
                          }
                        >
                          Review execution #{p.id}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </Panel>
          </div>
        </>
      )}
      {service === "bridge" && (
        <>
          <Notice tone="warning">
            Review both networks before bridging.
          </Notice>
          <Panel className="narrow-panel">
            <h2>Local Ethereum A → Local Ethereum B</h2>
            <p>
              The trusted relayer mints destination tokens after
              observing the source event. No decentralized security or automatic
              refund is provided.
            </p>
            {input("Source amount (dUSDC)")}
            <Address value={d.contracts.bridge} />
            <div className="form-actions">
              <Button
                variant="secondary"
                disabled={action.busy}
                onClick={() =>
                  void action.run(() =>
                    approveFor(d.contracts.bridge, d.allowances.bridge),
                  )
                }
              >
                Review exact bridge allowance
              </Button>
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(() =>
                    send(
                      "bridge",
                      parseAmount(amount, d.token.decimals).toString(),
                      d.contracts.bridge,
                      { recipient: d.accountAddress },
                    ),
                  )
                }
              >
                Review source lock
              </Button>
            </div>
            <Notice>
              pnpm dev runs the local CLI relayer. You can also run pnpm relayer
              --once. After timeout, resume the relayer. No automatic refund is provided.
            </Notice>
            <Button variant="secondary" onClick={() => void bridge.refetch()}>
              Check relayer status
            </Button>
            {bridge.error && (
              <Notice tone="warning">{bridge.error.message}</Notice>
            )}
            {bridge.data?.messages
              .filter(
                (m) =>
                  m.sender.toLowerCase() === d.accountAddress.toLowerCase() ||
                  m.recipient.toLowerCase() === d.accountAddress.toLowerCase(),
              )
              .map((m) => (
                <div className="position" key={m.id}>
                  <strong>
                    {m.state === "minted"
                      ? "Destination minted"
                      : m.state === "timeout"
                        ? "Relayer timeout · source locked"
                        : "Source locked · waiting for relayer"}
                  </strong>
                  <p>
                    {formatAmount(m.amount, d.token.decimals)} dUSDC → bdUSDC
                  </p>
                  <p>Message ID</p>
                  <Address value={m.id} />
                  <p>Source transaction</p>
                  <Address value={m.sourceHash} />
                  {m.destinationHash && (
                    <>
                      <p>Destination transaction</p>
                      <Address value={m.destinationHash} />
                    </>
                  )}
                </div>
              ))}
          </Panel>
        </>
      )}
      {receipt && <Notice>Node result: {receipt}</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
    </>
  );
}
