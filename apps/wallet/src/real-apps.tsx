import { Address, Button, Empty, Notice, PageTitle, Panel } from "@ewallet/ui";
import { formatAmount } from "@ewallet/domain";
import { useWallet, useAction } from "./context";
export function RealApps() {
  const { snapshot: s, gateway, review } = useWallet(),
    action = useAction();
  return (
    <>
      <PageTitle
        title="Connected apps"
        description="Disconnecting a connection grant does not revoke on-chain token allowances."
      />
      <Panel>
        <h2>Connection grants</h2>
        {s.permissions
          .filter((p) => !p.revoked)
          .map((p) => (
            <div className="permission-row" key={p.id}>
              <div>
                <strong>{p.origin}</strong>
                <p className="muted">{p.methods.join(", ")}</p>
                <p className="muted">
                  Expires {new Date(p.expiresAt).toLocaleString()}
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
        {!s.permissions.some((p) => !p.revoked) && (
          <Empty title="No connected apps">
            Only sites that integrate the e-wallet connector can request access.
          </Empty>
        )}
      </Panel>
      <Panel>
        <h2>Token authorizations</h2>
        <p className="muted">
          Tracked registered assets, within the most recent 2,000 blocks. Older
          or unregistered approvals may be missing.
        </p>
        {s.allowances?.map((a) => (
          <div className="position" key={a.id}>
            <strong>
              {formatAmount(a.raw, a.decimals)} {a.symbol}
            </strong>
            <p className="muted">Approved spender</p>
            <Address value={a.spender} />
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() =>
                void action.run(() =>
                  review({
                    requestId: crypto.randomUUID(),
                    accountId: s.selectedAccountId,
                    networkId: s.networkId,
                    kind: "revoke",
                    recipient: a.spender,
                    asset: a.asset,
                    amount: "0",
                    parameters: { tokenAccount: a.id },
                  }),
                )
              }
            >
              Review revoke {a.symbol}
            </Button>
          </div>
        ))}
        {!s.allowances?.length && (
          <Notice>No active allowances observed in this tracked range.</Notice>
        )}
      </Panel>
      {action.error && <Notice tone="error">{action.error}</Notice>}
    </>
  );
}
