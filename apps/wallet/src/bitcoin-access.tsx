import { useState } from "react";
import { Button, Notice, Panel } from "@ewallet/ui";
import { useAction, useWallet } from "./context";
export function BitcoinAccess() {
  const { gateway } = useWallet();
  const [allowed, setAllowed] = useState(false);
  const action = useAction();
  return (
    <Panel>
      <h2>Enable Bitcoin balance access</h2>
      <p>
        To find your Bitcoin balance and transactions, allow this app’s backend
        to look up the public addresses belonging to this account. Your recovery
        words and private keys stay on your device.
      </p>
      <details>
        <summary>What information is shared?</summary>
        <p>
          A public descriptor lets the backend link this account’s receive and
          change addresses, including future addresses, and read their activity.
          It cannot spend your funds.
        </p>
      </details>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={allowed}
          onChange={(event) => setAllowed(event.target.checked)}
        />
        I allow public-address lookup for this Bitcoin account.
      </label>
      <Button
        disabled={!allowed || action.busy}
        onClick={() =>
          void action.run(async () => {
            await gateway.connectBitcoinWatch?.();
            setAllowed(false);
          })
        }
      >
        {action.busy ? "Loading Bitcoin balances…" : "Enable Bitcoin balances"}
      </Button>
      {action.error && <Notice tone="error">{action.error}</Notice>}
    </Panel>
  );
}
