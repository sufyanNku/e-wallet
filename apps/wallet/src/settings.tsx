import { useState } from "react";
import { networks, networkById } from "@ewallet/config";
import type { Scenario } from "@ewallet/domain";
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
import { useWallet, useAction } from "./context";
import { useUiState } from "./ui-state";
export function download(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Settings() {
  const { snapshot: s, gateway, notify } = useWallet(),
    action = useAction();
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState(""),
    [words, setWords] = useState<string[]>([]),
    [ack, setAck] = useState(false);
  const remote = useUiState((v) => v.remoteMedia),
    setRemote = useUiState((v) => v.setRemoteMedia);
  return (
    <>
      <PageTitle
        title="Settings"
        description="Security, recovery and browser-local preferences."
      />
      <div className="content-grid">
        <div className="stack">
          <Panel>
            <h2>Lock and privacy</h2>
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
            <label className="check">
              <input
                type="checkbox"
                checked={remote}
                onChange={(e) => setRemote(e.target.checked)}
              />{" "}
              Request approved remote media (preview preference)
            </label>
            <p className="muted">
              Remote media can reveal an IP/address relationship. The mock
              gallery uses only local artwork.
            </p>
            <Button variant="secondary" onClick={() => gateway.lock()}>
              Lock wallet now
            </Button>
          </Panel>
          <Panel>
            <h2>Change sample password</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(async () => {
                  await gateway.changePassword(current, next, confirm);
                  setCurrent("");
                  setNext("");
                  setConfirm("");
                  notify(
                    "Sample password-change flow completed. No credential was persisted.",
                  );
                });
              }}
            >
              <Field
                label="Current sample password"
                type="password"
                value={current}
                autoComplete="off"
                onChange={(e) => setCurrent(e.target.value)}
              />
              <Field
                label="New sample password"
                type="password"
                value={next}
                autoComplete="new-password"
                onChange={(e) => setNext(e.target.value)}
              />
              <Field
                label="Confirm new sample password"
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(e) => setConfirm(e.target.value)}
              />
              <Button type="submit" disabled={action.busy}>
                Change sample password
              </Button>
            </form>
          </Panel>
        </div>
        <div className="stack">
          <Panel>
            <h2>Recovery and backup</h2>
            <Notice tone="warning">
              Mock backup contains public metadata only. It cannot restore a
              real wallet.
            </Notice>
            <Field
              label="Re-enter sample password"
              type="password"
              autoComplete="off"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
            <div className="form-actions">
              <Button
                variant="secondary"
                onClick={() =>
                  void action.run(async () => {
                    const phrase = await gateway.revealRecovery(current);
                    setCurrent("");
                    setWords(phrase);
                    setTimeout(() => setWords([]), 30000);
                  })
                }
              >
                Reveal sample words
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  void action.run(async () => {
                    await gateway.revealRecovery(current);
                    download(
                      "e-wallet-mock-backup.json",
                      gateway.exportPublicData(),
                    );
                    setCurrent("");
                  })
                }
              >
                Export sample backup
              </Button>
            </div>
            <p className="muted small">
              Recovery reveal closes after 30 seconds. There is no email
              password reset.
            </p>
          </Panel>
          <Panel>
            <h2>Browser data</h2>
            <Button
              variant="secondary"
              onClick={() =>
                download(
                  "e-wallet-public-data.json",
                  gateway.exportPublicData(),
                )
              }
            >
              Export public data
            </Button>
            <label className="check">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />{" "}
              I have checked my backup and want to reset only this sample
              wallet.
            </label>
            <Button
              variant="danger"
              onClick={() => void action.run(() => gateway.reset(current, ack))}
            >
              Reset sample wallet
            </Button>
          </Panel>
        </div>
      </div>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <Modal
        open={words.length > 0}
        onClose={() => setWords([])}
        title="Sample recovery words"
        description="Public, invalid sample data only. Never use these words for a real wallet."
      >
        <div className="word-grid">
          {words.map((w, i) => (
            <div key={w}>
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
export function Evaluation() {
  const { snapshot: s, gateway } = useWallet();
  return (
    <>
      <PageTitle
        title="Evaluation"
        description="Evidence describes checks that actually ran. Screen availability does not prove blockchain support."
      />
      <Notice tone="warning">
        {s.mode === "mock"
          ? "Current build: fixture preview. Real node execution and public-testnet acceptance are not verified."
          : "Current build: browser vault with a dedicated signing Worker. Chain execution and public-testnet acceptance are not yet verified."}
      </Notice>
      <div className="content-grid">
        <Panel>
          <h2>Build and data boundary</h2>
          <dl className="details">
            <dt>Mode</dt>
            <dd>{s.mode}</dd>
            <dt>Source</dt>
            <dd>{s.source}</dd>
            <dt>Selected network</dt>
            <dd>{networkById(s.networkId).name}</dd>
            <dt>Seed manifest</dt>
            <dd>Not seeded · No real chain evidence</dd>
            <dt>Signing</dt>
            <dd>Unavailable in mock mode</dd>
            <dt>Evidence records</dt>
            <dd>artifacts/phase-01 · implementation-status.json</dd>
          </dl>
          <p className="muted">
            The fifth specification file is missing. Later acceptance gates
            remain pending.
          </p>
        </Panel>
        <Panel>
          <h2>Network profiles</h2>
          <p className="muted">
            Configured identities are not proof of connectivity.
          </p>
          {networks.map((n) => (
            <div className="network-diagnostic" key={n.id}>
              <strong>{n.name}</strong>
              <span className="badge neutral">Not probed in UI</span>
              <Address value={n.id} />
            </div>
          ))}
        </Panel>
      </div>
      {import.meta.env.DEV && s.mode === "mock" && (
        <Panel>
          <h2>Development scenarios</h2>
          <Select
            label="Mock state scenario"
            value={s.scenario}
            onChange={(e) => gateway.setScenario(e.target.value as Scenario)}
          >
            {[
              "populated",
              "empty",
              "loading",
              "rpc-offline",
              "stale",
              "low-fee",
              "wrong-network",
              "rejected",
              "pending",
              "reverted",
              "expired-quote",
            ].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Select>
          <p className="muted">
            This scenario picker is excluded from production builds.
          </p>
        </Panel>
      )}
    </>
  );
}
