import { useState } from "react";
import {
  Button,
  Field,
  Modal,
  Notice,
  PageTitle,
  Panel,
  Select,
  Address,
} from "@ewallet/ui";
import { networkById } from "@ewallet/config";
import { useWallet, useAction } from "./context";
import type { RealWalletGateway } from "./real-gateway";
import { download } from "./settings";
export function RealSettings() {
  const { gateway, snapshot: s, notify } = useWallet(),
    action = useAction();
  const real = gateway as RealWalletGateway;
  const [password, setPassword] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState(""),
    [ack, setAck] = useState(false),
    [words, setWords] = useState<string[]>([]),
    [discovered, setDiscovered] = useState("");
  return (
    <>
      <PageTitle
        title="Settings"
        description="Encrypted storage belongs to this exact browser origin. Keep an offline recovery backup."
      />
      <div className="content-grid">
        <div className="stack">
          <Panel>
            <h2>Session security</h2>
            <Select
              label="Auto-lock after inactivity"
              value={s.autoLockMinutes}
              onChange={(e) =>
                gateway.setAutoLock(Number(e.target.value) as 1 | 5 | 15)
              }
            >
              <option value="1">1 minute</option>
              <option value="5">5 minutes</option>
              <option value="15">15 minutes</option>
            </Select>
            <p className="muted">
              A continuously hidden window locks after 60 seconds. Unlocking
              here never unlocks another window.
            </p>
            <Button variant="secondary" onClick={() => gateway.lock()}>
              Lock wallet
            </Button>
          </Panel>
          <Panel>
            <h2>Password and recovery</h2>
            <Field
              label="Current wallet password"
              type="password"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="form-actions">
              <Button
                variant="secondary"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    setWords(await gateway.revealRecovery(password));
                    setPassword("");
                    setTimeout(() => setWords([]), 30000);
                  })
                }
              >
                Reveal recovery phrase
              </Button>
              <Button
                variant="secondary"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const backup = await real.exportEncrypted(password);
                    setPassword("");
                    download("e-wallet-encrypted-backup.json", backup);
                    notify(
                      "Encrypted backup downloaded. Store its password separately.",
                    );
                  })
                }
              >
                Export encrypted backup
              </Button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(async () => {
                  await gateway.changePassword(password, next, confirm);
                  setPassword("");
                  setNext("");
                  setConfirm("");
                  notify("Password changed and encrypted storage verified.");
                });
              }}
            >
              <Field
                label="New wallet password"
                type="password"
                value={next}
                autoComplete="new-password"
                onChange={(e) => setNext(e.target.value)}
              />
              <Field
                label="Confirm new wallet password"
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(e) => setConfirm(e.target.value)}
              />
              <Button type="submit" disabled={action.busy}>
                Change password
              </Button>
            </form>
          </Panel>
        </div>
        <div className="stack">
          <Panel>
            <h2>Public account metadata</h2>
            <label className="checkbox-label"><input type="checkbox" checked={s.remoteMediaAllowed===true} onChange={e=>void action.run(()=>gateway.setRemoteMediaAllowed?.(e.target.checked))}/>Allow remote NFT media when I request it</label>
            <p className="muted">Remote servers can learn which media was requested. Images stay blocked until you request details; safe cached local images remain available.</p>
            <p className="muted">
              Save public paths and indexes to help restore derived accounts.
              This does not replace your recovery phrase.
            </p>
            <Button
              variant="secondary"
              onClick={() =>
                download(
                  "e-wallet-public-metadata.json",
                  gateway.exportPublicData(),
                )
              }
            >
              Export public metadata
            </Button>
            <h3 className="subheading">Supported path discovery</h3>
            <p className="muted">
              Scan supported {networkById(s.networkId).family} paths using the selected node. Used EVM/Solana accounts are recovered locally; Bitcoin scans the consented account’s receive and change branches. Coverage and bounds are shown in the result.
            </p>
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  setDiscovered(
                    JSON.stringify(
                      await real.discover(networkById(s.networkId).family),
                      null,
                      2,
                    ),
                  );
                })
              }
            >
              Derive public recovery candidates
            </Button>
            {discovered && <Address value={discovered} />}
          </Panel>
          <Panel>
            <h2>Reset browser wallet</h2>
            <Notice tone="warning">
              Reset removes only this application's local encrypted wallet and
              public data. It cannot delete blockchain funds.
            </Notice>
            <label className="check">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />{" "}
              I have my offline recovery backup and want to reset this browser
              wallet.
            </label>
            <Button
              variant="danger"
              disabled={action.busy}
              onClick={() =>
                void action.run(() => gateway.reset(password, ack))
              }
            >
              Reset wallet after password verification
            </Button>
          </Panel>
        </div>
      </div>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <Modal
        open={words.length > 0}
        onClose={() => setWords([])}
        title="Recovery phrase"
        description="Keep these words offline and private. They disappear after 30 seconds."
      >
        <div className="word-grid">
          {words.map((w, i) => (
            <div key={i}>
              <span>{i + 1}</span>
              {w}
            </div>
          ))}
        </div>
        <Button onClick={() => setWords([])}>Clear and close</Button>
      </Modal>
    </>
  );
}
