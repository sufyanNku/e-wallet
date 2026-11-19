import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { WalletCards, KeyRound } from "lucide-react";
import { Button, Field, Panel, Notice } from "@ewallet/ui";
import { useWallet, useAction } from "./context";
import type { RealWalletGateway } from "./real-gateway";
export function RealWelcome() {
  const { snapshot: s } = useWallet();
  return (
    <div className="onboarding">
      <div className="welcome-mark">
        <WalletCards size={42} />
      </div>
      <h1>
        Your world.
        <br />
        In your wallet.
      </h1>
      <p className="intro">
        Send, receive and explore across networks. You hold the keys; your
        recovery phrase keeps you in control.
      </p>
      <div className="stack">
        {s.initialized && (
          <Link className="button primary" to={s.locked ? "/unlock" : "/"}>
            {s.locked ? "Unlock saved wallet" : "Open saved wallet"}
          </Link>
        )}
        {!s.initialized && (
          <Link className="button primary" to="/create">
            Create wallet
          </Link>
        )}
        <Link
          className="button secondary"
          to={s.initialized ? (s.locked ? "/unlock" : "/settings") : "/import"}
        >
          {s.initialized ? "Manage saved wallet" : "Restore wallet"}
        </Link>
        {__WALLET_MODE__ === "local" && (
          <Link className="text-link" to="/accounts">
            Account sign-in and registration
          </Link>
        )}
      </div>
      <p className="muted small">
        Unlock this wallet with its wallet password; no username is needed.
        Credit accounts have a separate username and account password.
      </p>
    </div>
  );
}
function SavedWallet() {
  const { snapshot: s } = useWallet();
  return (
    <div className="onboarding wide">
      <h1>A wallet is already saved here</h1>
      <Panel>
        <h2>Open your existing wallet</h2>
        <p>
          This browser already contains an encrypted wallet. Unlock it with the
          password you chose when creating it; you do not need a username.
        </p>
        <div className="form-actions">
          <Link className="button primary" to={s.locked ? "/unlock" : "/"}>
            {s.locked ? "Unlock existing wallet" : "Open existing wallet"}
          </Link>
          <Link
            className="button secondary"
            to={s.locked ? "/unlock" : "/settings"}
          >
            Manage wallet
          </Link>
        </div>
        <p className="muted">
          To use different recovery words, first back up this wallet, then
          remove it in Settings. Restoring never silently overwrites your
          existing keys.
        </p>
      </Panel>
      <Link className="text-link" to="/welcome">
        Back to welcome
      </Link>
    </div>
  );
}
export function RealCreate() {
  const { gateway, snapshot: s } = useWallet(),
    nav = useNavigate(),
    action = useAction();
  const [step, setStep] = useState(0),
    [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [words, setWords] = useState<string[]>([]),
    [challenge, setChallenge] = useState<number[]>([]),
    [answers, setAnswers] = useState(["", "", ""]),
    [ack, setAck] = useState(false);
  useEffect(() => {
    const clear = () => {
      setWords([]);
      setPassword("");
      setConfirmation("");
      setAnswers(["", "", ""]);
    };
    window.addEventListener("pagehide", clear);
    return () => {
      clear();
      window.removeEventListener("pagehide", clear);
    };
  }, []);
  useEffect(() => {
    if (s.lastError?.code === "LOCKED") {
      setWords([]);
      setAnswers(["", "", ""]);
      setStep(0);
    }
  }, [s.lastError]);
  if (s.initialized && step === 0) return <SavedWallet />;
  return (
    <div className="onboarding wide">
      <Link className="text-link" to="/welcome">
        ← Back to welcome
      </Link>
      <h1>
        {
          [
            "Create wallet",
            "Back up your recovery phrase",
            "Verify your backup",
          ][step]
        }
      </h1>
      <p className="muted">Step {step + 1} of 3</p>
      <Notice tone="warning">
        Keep recovery words private and offline. Never share them with anyone.
      </Notice>
      <Panel>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              if (step === 0) {
                const r = await gateway.create(password, confirmation);
                setPassword("");
                setConfirmation("");
                setWords(r.words);
                setChallenge(r.challenge);
                setStep(1);
              } else if (step === 1) {
                if (!ack)
                  throw new Error(
                    "Confirm that you have stored your recovery backup safely.",
                  );
                setWords([]);
                setStep(2);
              } else {
                await gateway.finishBackup(answers, ack);
                setAnswers(["", "", ""]);
                const accounts = await fetch("/api/v1/accounts/status")
                  .then((r) => (r.ok ? r.json() : null))
                  .catch(() => null);
                nav(
                  accounts?.data?.enabled
                    ? "/accounts?mode=register&from=wallet"
                    : "/",
                );
              }
            });
          }}
        >
          {step === 0 ? (
            <>
              <Field
                label="Wallet password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                hint="At least 12 characters. Spaces and Unicode are supported. This password unlocks only this browser."
              />
              <Field
                label="Confirm wallet password"
                type="password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="new-password"
              />
            </>
          ) : step === 1 ? (
            <>
              <div className="word-grid">
                {words.map((word, i) => (
                  <div key={i}>
                    <span>{i + 1}</span>
                    {word}
                  </div>
                ))}
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />{" "}
                I stored all 24 words in order, offline, and understand that
                losing them can permanently lose access.
              </label>
            </>
          ) : (
            challenge.map((n, i) => (
              <Field
                key={n}
                label={`Recovery word ${n + 1}`}
                value={answers[i]}
                onChange={(e) =>
                  setAnswers((a) =>
                    a.map((v, j) => (j === i ? e.target.value : v)),
                  )
                }
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
              />
            ))
          )}
          {action.error && <Notice tone="error">{action.error}</Notice>}
          <Button type="submit" disabled={action.busy}>
            {action.busy
              ? "Securing wallet…"
              : step === 2
                ? "Verify and open wallet"
                : "Continue"}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
export function RealImport() {
  const { gateway, snapshot: s } = useWallet(),
    nav = useNavigate(),
    action = useAction();
  const [mnemonic, setMnemonic] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [passphrase, setPassphrase] = useState(""),
    [encrypted, setEncrypted] = useState(""),
    [ack, setAck] = useState(false),
    [kind, setKind] = useState<"phrase" | "encrypted">("phrase");
  if (s.initialized) return <SavedWallet />;
  return (
    <div className="onboarding wide">
      <Link className="text-link" to="/welcome">
        ← Back to welcome
      </Link>
      <h1>Restore your wallet</h1>
      <Notice tone="warning">
        Recovery requires your exact words and optional BIP39 passphrase.
      </Notice>
      <div className="form-actions">
        <Button
          variant={kind === "phrase" ? "primary" : "secondary"}
          onClick={() => setKind("phrase")}
        >
          Recovery phrase
        </Button>
        <Button
          variant={kind === "encrypted" ? "primary" : "secondary"}
          onClick={() => setKind("encrypted")}
        >
          Encrypted backup
        </Button>
      </div>
      <Panel>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              if (kind === "phrase")
                await gateway.restorePhrase(
                  mnemonic.replace(/[,;，]+/g, " ").trim(),
                  password,
                  confirm,
                  passphrase,
                );
              else
                await (gateway as RealWalletGateway).restoreEncrypted(
                  encrypted,
                  password,
                  ack,
                );
              setMnemonic("");
              setPassword("");
              setConfirm("");
              setPassphrase("");
              setEncrypted("");
              nav("/");
            });
          }}
        >
          {kind === "phrase" ? (
            <>
              <label className="field">
                Recovery phrase (12 or 24 English words)
                <textarea
                  value={mnemonic}
                  onChange={(e) => setMnemonic(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="none"
                  rows={5}
                />
              </label>
              <details>
                <summary>Advanced: BIP39 passphrase</summary>
                <Field
                  label="BIP39 passphrase"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  hint="Separate from the local unlock password. A different passphrase creates different accounts."
                />
              </details>
            </>
          ) : (
            <>
              <label className="field">
                Encrypted backup file
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) =>
                    void action.run(async () => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (f.size > 65536)
                        throw new Error("Encrypted backup exceeds 64 KiB.");
                      setEncrypted(await f.text());
                    })
                  }
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />{" "}
                I understand this restores the encrypted wallet into this
                browser origin.
              </label>
            </>
          )}
          <Field
            label={
              kind === "phrase" ? "New wallet password" : "Backup password"
            }
            type="password"
            autoComplete={kind === "phrase" ? "new-password" : "off"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {kind === "phrase" && (
            <Field
              label="Confirm new wallet password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
          <p className="muted small">
            Existing wallets must be backed up and reset before replacing the
            root.
          </p>
          {action.error && <Notice tone="error">{action.error}</Notice>}
          <Button type="submit" disabled={action.busy}>
            {action.busy ? "Restoring…" : "Restore wallet"}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
export function RealUnlock() {
  const { gateway, snapshot: s } = useWallet(),
    nav = useNavigate(),
    action = useAction();
  const [password, setPassword] = useState("");
  return (
    <div className="onboarding">
      <KeyRound size={36} className="mint" />
      <h1>Your wallet is locked</h1>
      <p className="muted">
        Enter the wallet password you chose when you created or restored this
        wallet. No username is needed. Reloading or closing a window locks it.
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
            label="Wallet password"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {action.error && <Notice tone="error">{action.error}</Notice>}
          <Button type="submit" disabled={action.busy}>
            {action.busy ? "Unlocking…" : "Unlock wallet"}
          </Button>
        </form>
      </Panel>
      <p className="muted small">
        Forgot this password? Restore your recovery words in a private browser
        window to recover access without deleting the wallet saved here. An
        encrypted backup still needs its own password.
      </p>
      {s.lastError && s.lastError.code !== "LOCKED" && (
        <Notice tone="warning">{s.lastError.message}</Notice>
      )}
    </div>
  );
}
