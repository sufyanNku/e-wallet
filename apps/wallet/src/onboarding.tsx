import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ShieldCheck, ArrowRight, KeyRound, WalletCards } from "lucide-react";
import { Button, Field, Panel, Notice } from "@ewallet/ui";
import { useWallet, useAction } from "./context";
import type { MockWalletGateway } from "./mock-gateway";

export function Welcome() {
  const { gateway } = useWallet();
  const nav = useNavigate();
  return (
    <div className="onboarding">
      <div className="welcome-mark">
        <WalletCards size={42} />
      </div>
      <span className="eyebrow">Your keys. Your wallet.</span>
      <h1>
        A little closer to
        <br />
        your digital world.
      </h1>
      <p className="intro">
        One place to explore assets, send test tokens and learn how self-custody
        works.
      </p>
      <Notice tone="warning">
        Mock preview only. Never enter a real recovery phrase or password.
      </Notice>
      <div className="stack">
        <Link className="button primary" to="/create">
          Create sample wallet <ArrowRight size={18} />
        </Link>
        <Link className="button secondary" to="/import">
          Import sample wallet
        </Link>
        {__WALLET_MODE__ === "mock" && (
          <Button
            variant="ghost"
            onClick={() => {
              (gateway as MockWalletGateway).loadSample();
              nav("/");
            }}
          >
            Explore sample wallet
          </Button>
        )}
      </div>
      <p className="muted small">
        <ShieldCheck size={16} /> Self-custody starts with a safe recovery
        backup.
      </p>
    </div>
  );
}
export function Create() {
  const { gateway } = useWallet();
  const nav = useNavigate();
  const [step, setStep] = useState(0),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [words, setWords] = useState<string[]>([]),
    [challenge, setChallenge] = useState<number[]>([]),
    [answers, setAnswers] = useState(["", "", ""]),
    [ack, setAck] = useState(false);
  const action = useAction();
  useEffect(
    () => () => {
      setWords([]);
      setPassword("");
      setConfirm("");
    },
    [],
  );
  return (
    <div className="onboarding wide">
      <Link to="/welcome" className="text-link">
        ← Back to welcome
      </Link>
      <h1>
        {
          [
            "Create your sample wallet",
            "Back up the sample words",
            "Check your sample backup",
          ][step]
        }
      </h1>
      <p className="muted">Step {step + 1} of 3 · Preview onboarding</p>
      <Notice tone="warning">
        Use sample inputs only. Nothing entered here is persisted or used to
        derive keys.
      </Notice>
      <Panel>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              if (step === 0) {
                const r = await gateway.create(password, confirm);
                setWords(r.words);
                setChallenge(r.challenge);
                setPassword("");
                setConfirm("");
                setStep(1);
              } else if (step === 1) {
                if (!ack)
                  throw new Error("Acknowledge the backup before continuing.");
                setStep(2);
              } else {
                await gateway.finishBackup(answers, ack);
                setWords([]);
                nav("/");
              }
            });
          }}
        >
          {step === 0 ? (
            <>
              <Field
                label="Sample password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                hint="At least 12 characters. A long phrase with spaces works well."
              />
              <Field
                label="Confirm sample password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </>
          ) : step === 1 ? (
            <>
              <div className="word-grid">
                {words.map((w, i) => (
                  <div key={w}>
                    <span>{i + 1}</span>
                    {w}
                  </div>
                ))}
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />{" "}
                I understand this is a public, invalid sample phrase and have
                checked the backup.
              </label>
            </>
          ) : (
            challenge.map((n, i) => (
              <Field
                key={n}
                label={`Sample word ${n + 1}`}
                value={answers[i]}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) =>
                  setAnswers((a) =>
                    a.map((v, j) => (i === j ? e.target.value : v)),
                  )
                }
              />
            ))
          )}
          {action.error && <Notice tone="error">{action.error}</Notice>}
          <Button type="submit" disabled={action.busy}>
            {step === 2 ? "Open sample wallet" : "Continue"}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
export function Import() {
  const { gateway } = useWallet();
  const nav = useNavigate();
  const [words, setWords] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [passphrase, setPassphrase] = useState("");
  const action = useAction();
  return (
    <div className="onboarding wide">
      <Link className="text-link" to="/welcome">
        ← Back to welcome
      </Link>
      <h1>Import sample wallet</h1>
      <Notice tone="warning">
        Do not enter real recovery words. This preview accepts only the
        designated sample data.
      </Notice>
      <Panel>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await gateway.importSample(words, password, confirm, passphrase);
              setWords("");
              setPassword("");
              setPassphrase("");
              nav("/");
            });
          }}
        >
          <label className="field">
            Sample recovery words
            <textarea
              value={words}
              onChange={(e) => setWords(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              rows={5}
            />
          </label>
          <Button
            variant="ghost"
            type="button"
            onClick={() =>
              setWords(
                Array.from(
                  { length: 24 },
                  (_, i) => `sample${String(i + 1).padStart(2, "0")}`,
                ).join(" "),
              )
            }
          >
            Fill designated sample words
          </Button>
          <details>
            <summary>Advanced: sample BIP39 passphrase</summary>
            <Field
              label="Sample passphrase"
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              hint="A recovery passphrase is separate from your local unlock password. Preview only."
            />
          </details>
          <Field
            label="Sample password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Field
            label="Confirm sample password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {action.error && <Notice tone="error">{action.error}</Notice>}
          <Button type="submit" disabled={action.busy}>
            Import sample wallet
          </Button>
        </form>
      </Panel>
    </div>
  );
}
export function Unlock() {
  const { gateway } = useWallet(),
    nav = useNavigate(),
    action = useAction();
  const [password, setPassword] = useState("");
  return (
    <div className="onboarding">
      <KeyRound size={36} className="mint" />
      <h1>Your wallet is locked</h1>
      <p className="muted">
        Unlock this preview with any sample input of at least 12 characters.
        Mock mode does not store credentials.
      </p>
      <Panel>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await gateway.unlock(password);
              setPassword("");
              nav("/");
            });
          }}
        >
          <Field
            label="Sample password"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {action.error && <Notice tone="error">{action.error}</Notice>}
          <Button type="submit" disabled={action.busy}>
            Unlock sample wallet
          </Button>
        </form>
      </Panel>
      <p className="muted">
        Forgot a real wallet password? Only your recovery phrase restores
        access; there is no email reset.
      </p>
    </div>
  );
}
