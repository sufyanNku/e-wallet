import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  ArrowUpRight,
  RefreshCw,
  ArrowLeftRight,
  WalletCards,
  PanelsTopLeft,
} from "lucide-react";
import { Button, Notice, PageTitle, Panel } from "@ewallet/ui";
import { formatUsd } from "@ewallet/domain";
import { Coin } from "./portfolio";
type Markets = {
  assets: Array<{ symbol: string; name: string; microUsd: string }>;
  observedAt: string | null;
  source: string;
  stale: boolean;
};
export function Discover() {
  const q = useQuery({
    queryKey: ["markets"],
    queryFn: async () => {
      const r = await fetch("/api/v1/markets", {
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error("Market data is temporarily unavailable.");
      return (await r.json()).data as Markets;
    },
    staleTime: 60000,
    retry: 1,
  });
  return (
    <>
      <PageTitle
        title="Discover"
        description="Keep an eye on the market. Explore what your wallet can do."
        action={
          <Button
            variant="ghost"
            aria-label="Refresh market prices"
            disabled={q.isFetching}
            onClick={() => void q.refetch()}
          >
            <RefreshCw size={18} />
          </Button>
        }
      />
      <Panel className="market-panel">
        <div className="section-heading">
          <h2>Market watch</h2>
          <span className="muted small">USD spot prices</span>
        </div>
        {q.isPending ? (
          <div
            className="asset-skeleton"
            role="status"
            aria-label="Loading market prices"
          >
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <span />
                <span />
                <span />
              </div>
            ))}
          </div>
        ) : q.data?.assets.length ? (
          q.data.assets.map((item) => (
            <div className="asset-row" key={item.symbol}>
              <Coin symbol={item.symbol} />
              <div className="asset-name">
                <strong>{item.name}</strong>
                <small>{item.symbol}</small>
              </div>
              <div className="asset-quantity">
                <strong>{formatUsd(item.microUsd)}</strong>
                <small>Market reference</small>
              </div>
            </div>
          ))
        ) : (
          <Notice>
            Live market quotes are unavailable. Refresh to try again.
          </Notice>
        )}
        {q.data?.stale && (
          <Notice tone="warning">
            Some quotes could not refresh. Check the observation time.
          </Notice>
        )}
        <p className="footnote">
          {q.data?.source ?? "Coinbase spot"}
          {q.data?.observedAt
            ? " · Observed " + new Date(q.data.observedAt).toLocaleTimeString()
            : ""}
        </p>
      </Panel>
      <div className="discover-actions">
        {[
          {
            to: "/swap",
            title: "Make a swap",
            copy: "Review a quote, fees and the exact allowance before signing.",
            icon: ArrowLeftRight,
          },
          {
            to: "/collectibles",
            title: "Your collection",
            copy: "Explore the collectibles your wallet actually owns.",
            icon: WalletCards,
          },
          {
            to: "/apps",
            title: "Your connections",
            copy: "Review permissions and revoke access you no longer need.",
            icon: PanelsTopLeft,
          },
        ].map(({ to, title, copy, icon: Icon }) => (
          <Link key={to} to={to}>
            <Icon size={25} />
            <div>
              <h2>{title}</h2>
              <p>{copy}</p>
            </div>
            <ArrowUpRight size={19} />
          </Link>
        ))}
      </div>
      <Link className="text-link" to="/services">
        Explore network tools <ArrowUpRight size={16} />
      </Link>
    </>
  );
}
