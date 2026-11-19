import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, Field, Notice, Panel } from "@ewallet/ui";
import { useAction, useWallet } from "./context";
import type { RealWalletGateway } from "./real-gateway";

export function WalletAccessActions() {
  return (
    <div className="stack wallet-access-actions">
      <Link className="button secondary" to="/reset?next=create">
        Create new wallet
      </Link>
      <Link className="button secondary" to="/reset?next=import">
        Restore wallet
      </Link>
      <Link className="text-link" to="/reset">
        Reset wallet
      </Link>
    </div>
  );
}

export function ResetWallet() {
  const { gateway, snapshot } = useWallet();
  const real = gateway as RealWalletGateway;
  const action = useAction();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const destination =
    next === "create" ? "/create" : next === "import" ? "/import" : "/welcome";
  const [target, setTarget] = useState<{
    walletId: string;
    revision: number;
  } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    let active = true;
    void real
      .resetTarget()
      .then((value) => {
        if (active) setTarget(value);
      })
      .catch((error) => {
        if (active) setLoadError(error.message);
      });
    return () => {
      active = false;
    };
  }, [real]);
  if (!snapshot.initialized)
    return (
      <div className="onboarding">
        <h1>No wallet is saved here</h1>
        <Link className="button primary" to={destination}>
          Continue
        </Link>
      </div>
    );
  return (
    <div className="onboarding wide">
      <h1>
        {next === "create"
          ? "Create a new wallet"
          : next === "import"
            ? "Restore another wallet"
            : "Reset wallet"}
      </h1>
      <p className="muted">
        This browser already has a wallet. Keep its recovery backup before
        replacing it. To keep both wallets on this computer, use a separate
        browser profile.
      </p>
      <Panel>
        <h2>Remove the saved wallet from this browser</h2>
        <Notice tone="warning">
          Reset deletes this browser’s encrypted wallet, saved contacts, app
          connections and transaction cache. It does not move blockchain assets
          or reset credit-account balances. Without the recovery phrase or a
          usable encrypted backup, you can permanently lose access.
        </Notice>
        <p className="muted">
          You do not need the old password to remove local wallet data. Removal
          cannot reveal recovery words or unlock funds.
        </p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(async () => {
              if (!target)
                throw new Error(
                  "Reload this page to check the saved wallet before resetting.",
                );
              await real.forgetWallet(target, confirmation, acknowledged);
              navigate(destination, { replace: true });
            });
          }}
        >
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I have saved my recovery backup and understand that reset removes
            this wallet from this browser.
          </label>
          <Field
            label="Type RESET WALLET to confirm"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          {(loadError || action.error) && (
            <Notice tone="error">{action.error || loadError}</Notice>
          )}
          <Button
            variant="danger"
            type="submit"
            disabled={
              action.busy ||
              !target ||
              !acknowledged ||
              confirmation !== "RESET WALLET"
            }
          >
            {action.busy
              ? "Removing saved wallet…"
              : next === "create"
                ? "Reset and create new wallet"
                : next === "import"
                  ? "Reset and restore wallet"
                  : "Reset wallet"}
          </Button>
        </form>
      </Panel>
      <Link className="button secondary" to={snapshot.locked ? "/unlock" : "/"}>
        Cancel and keep saved wallet
      </Link>
    </div>
  );
}
