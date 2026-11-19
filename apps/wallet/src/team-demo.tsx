import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowLeftRight, LogOut, ShieldCheck } from "lucide-react";
import { Button, Field, Notice, Panel, Select } from "@ewallet/ui";
import type {
  TeamAdmin,
  TeamDashboard,
} from "../../../packages/domain/src/team-demo";
import "./team-demo.css";

class DemoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export function TeamDemo() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [dashboard, setDashboard] = useState<TeamDashboard | null>(null);
  const [admin, setAdmin] = useState<TeamAdmin | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState<{
    recipientId: string;
    amount: string;
    requestId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const csrf = useRef<Promise<string> | null>(null);
  const accountRevision = useRef(0);
  const request = useCallback(
    async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const token = await (csrf.current ??= fetch("/api/v1/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then(async (r) => {
        if (!r.ok) {
          csrf.current = null;
          throw new Error("The demo session could not start. Reload to retry.");
        }
        return (await r.json()).data.csrfToken as string;
      }));
      const response = await fetch("/api/v1/team-demo" + path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        ...(method !== "GET"
          ? {
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": token,
              },
              body: JSON.stringify(body ?? {}),
            }
          : {}),
      });
      const data = await response.json();
      if (!response.ok)
        throw new DemoError(
          data.error?.message ?? "The demo request failed.",
          response.status,
        );
      return data.data as T;
    },
    [],
  );
  const clearAccount = useCallback(() => {
    accountRevision.current++;
    setDashboard(null);
    setAdmin(null);
    setReview(null);
    setAmount("");
    setRecipientId("");
    setPassword("");
  }, []);
  const refresh = useCallback(async () => {
    const revision = accountRevision.current;
    try {
      const d = await request<TeamDashboard>("/dashboard");
      const report =
        d.user.role !== "member" ? await request<TeamAdmin>("/admin") : null;
      if (revision !== accountRevision.current) return;
      setDashboard(d);
      setAdmin(report);
    } catch (e) {
      if (revision !== accountRevision.current) return;
      if (e instanceof DemoError && e.status === 401) clearAccount();
      throw e;
    }
  }, [request, clearAccount]);
  useEffect(() => {
    let active = true;
    void fetch("/api/v1/team-demo/status", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok)
          throw new Error("Restart the backend to load classroom accounts.");
        const status = await r.json();
        if (!active) return;
        setEnabled(status.data.enabled);
        if (status.data.enabled) await refresh();
      })
      .catch((e) => {
        if (active && !(e instanceof DemoError && e.status === 401))
          setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!dashboard) return;
    const timer = setInterval(() => {
      if (!document.hidden && !busy)
        void refresh().catch((e) => setError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [dashboard, busy, refresh]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The demo request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="team-demo">
      <header className="team-header">
        <Link className="brand" to="/">
          <span className="brand-mark product-mark" aria-hidden="true">
            e
          </span>{" "}
          e-wallet
        </Link>
        <Link to="/welcome" className="text-link">
          Back to crypto wallet
        </Link>
        {dashboard && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await request("/logout", "POST");
                clearAccount();
                setNotice("Signed out of the classroom demo.");
              })
            }
          >
            <LogOut size={16} /> Sign out
          </Button>
        )}
      </header>
      <main className="team-main" id="main-content">
        <div className="team-title">
          <p className="eyebrow">LOCAL CLASSROOM DEMO</p>
          <h1>Accounts. Roles. Transfers.</h1>
          <p className="muted">
            Demo credits · No real money or blockchain transaction.
          </p>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {notice && <Notice tone="success">{notice}</Notice>}
        {enabled === null && !error && (
          <p role="status">Connecting to the classroom demo…</p>
        )}
        {enabled === false && (
          <Panel>
            <h2>Enable classroom accounts</h2>
            <p>
              Stop the current development server, run these commands in the
              project folder, then open this page again.
            </p>
            <pre>pnpm demo:setup{"\n"}pnpm demo:dev</pre>
            <p className="muted">
              Setup saves randomly generated passwords in
              .local/local/team-demo-credentials.json. See RBAC_DEMO_GUIDE.md.
            </p>
          </Panel>
        )}
        {enabled && !dashboard && (
          <div className="team-login-grid">
            <Panel>
              <ShieldCheck size={28} />
              <h2>Sign in to the demo</h2>
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    clearAccount();
                    try {
                      await request("/login", "POST", { username, password });
                      await refresh();
                    } finally {
                      setPassword("");
                    }
                  });
                }}
              >
                <Field
                  label="Username"
                  autoComplete="username"
                  autoCapitalize="none"
                  value={username}
                  required
                  maxLength={64}
                  onChange={(e) => setUsername(e.target.value)}
                />
                <Field
                  label="Password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  required
                  maxLength={256}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button type="submit" disabled={busy}>
                  {busy ? "Signing in…" : "Sign in"}
                </Button>
              </form>
            </Panel>
            <section className="team-explainer">
              <h2>One presentation, three roles.</h2>
              <p>
                <strong>Member</strong> · Alice and Bob can send credits and see
                their own transfer history.
              </p>
              <p>
                <strong>Admin</strong> · Reviews all activity and can suspend or
                re-enable Members.
              </p>
              <p>
                <strong>Auditor</strong> · Reads reports, with transfers and
                account changes blocked by the server.
              </p>
              <p className="muted">
                Use separate browser profiles or a normal window and an
                incognito window to sign in as two users at once.
              </p>
            </section>
          </div>
        )}
        {dashboard && (
          <>
            <div className="team-account-heading">
              <div>
                <h2>{dashboard.user.displayName}</h2>
                <p className="muted">
                  @{dashboard.user.username} ·{" "}
                  <strong data-testid="team-role">{dashboard.user.role}</strong>
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void action(refresh)}
              >
                Refresh balances
              </Button>
            </div>
            <div className="team-wallet-grid">
              <section className="team-balance">
                <p>Available demo credits</p>
                <strong data-testid="team-balance">{dashboard.balance}</strong>
                <p>Local balance · Demo only</p>
              </section>
              <Panel>
                {dashboard.canTransfer ? (
                  <>
                    <h2>
                      <ArrowLeftRight size={20} /> Send demo credits
                    </h2>
                    {!review ? (
                      <form
                        className="stack"
                        onSubmit={(e) => {
                          e.preventDefault();
                          setError("");
                          setNotice("");
                          if (
                            !recipientId ||
                            !/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,2})?$/.test(
                              amount,
                            ) ||
                            Number(amount) <= 0
                          ) {
                            setError(
                              "Choose a recipient and enter a positive amount with at most two decimal places.",
                            );
                            return;
                          }
                          setReview({
                            recipientId,
                            amount,
                            requestId: crypto.randomUUID(),
                          });
                        }}
                      >
                        <Select
                          label="Recipient"
                          value={recipientId}
                          onChange={(e) => setRecipientId(e.target.value)}
                          required
                        >
                          <option value="">Choose an account</option>
                          {dashboard.recipients.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.displayName} (@{u.username})
                            </option>
                          ))}
                        </Select>
                        <Field
                          label="Amount in demo credits"
                          inputMode="decimal"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          required
                          maxLength={9}
                          placeholder="25.00"
                        />
                        <Button
                          disabled={busy || !dashboard.recipients.length}
                          type="submit"
                        >
                          Review transfer
                        </Button>
                      </form>
                    ) : (
                      <div className="stack">
                        <h3>Confirm transfer</h3>
                        <p>
                          Send <strong>{review.amount} demo credits</strong> to{" "}
                          <strong>
                            {dashboard.recipients.find(
                              (r) => r.id === review.recipientId,
                            )?.displayName ?? "selected recipient"}
                          </strong>
                          ?
                        </p>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              const result = await request<{ id: string }>(
                                "/transfers",
                                "POST",
                                review,
                              );
                              setReview(null);
                              setAmount("");
                              setNotice(
                                "Transfer completed. Receipt: " + result.id,
                              );
                              await refresh();
                            })
                          }
                        >
                          {busy ? "Sending…" : "Confirm transfer"}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setReview(null)}
                        >
                          Back to edit
                        </Button>
                        <small className="muted">
                          A retry uses the same request ID so an interrupted
                          response cannot debit you twice.
                        </small>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <h2>Read-only access</h2>
                    <p>
                      Your Auditor role can inspect reports. The server rejects
                      transfers and account changes.
                    </p>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          try {
                            await request("/transfers", "POST", {
                              recipientId:
                                dashboard.recipients[0]?.id ??
                                dashboard.user.id,
                              amount: "1.00",
                              requestId: crypto.randomUUID(),
                            });
                          } catch (e) {
                            if (e instanceof DemoError && e.status === 403) {
                              setNotice(
                                "Server returned 403: Auditor transfers are blocked. No credits moved.",
                              );
                              return;
                            }
                            throw e;
                          }
                        })
                      }
                    >
                      Check transfer permission
                    </Button>
                  </>
                )}
              </Panel>
            </div>
            {dashboard.user.role === "member" && (
              <div className="team-permission-check">
                <p className="muted">
                  Members cannot open administrative reports.
                </p>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      try {
                        await request("/admin");
                      } catch (e) {
                        if (e instanceof DemoError && e.status === 403) {
                          setNotice(
                            "Server returned 403: Member access to admin reports is blocked.",
                          );
                          return;
                        }
                        throw e;
                      }
                    })
                  }
                >
                  Check admin permission
                </Button>
              </div>
            )}
            <Panel>
              <h2>
                {dashboard.user.role === "member"
                  ? "Your transfers"
                  : "All transfers"}
              </h2>
              {!dashboard.transfers.length ? (
                <p className="muted">
                  No transfers yet. Send credits from Alice to Bob to start the
                  demonstration.
                </p>
              ) : (
                <ol className="team-history">
                  {dashboard.transfers.map((t) => (
                    <li key={t.id}>
                      <div>
                        <strong>
                          {t.sender} → {t.recipient}
                        </strong>
                        <p className="muted">
                          {new Date(t.createdAt).toLocaleString()}
                        </p>
                        <code>{t.id}</code>
                      </div>
                      <strong>{t.amount} credits</strong>
                    </li>
                  ))}
                </ol>
              )}
              <p className="muted small">
                Shows the latest 50 transfers visible to your role.
              </p>
            </Panel>
            {admin && (
              <>
                <Panel>
                  <h2>Account oversight</h2>
                  <p className="muted">
                    {dashboard.user.role === "admin"
                      ? "Suspending a Member revokes their current sessions immediately."
                      : "Read-only report. Only Admin can suspend a Member."}
                  </p>
                  <ul className="team-users">
                    {admin.users.map((u) => (
                      <li key={u.id}>
                        <div>
                          <strong>{u.displayName}</strong>
                          <p className="muted">
                            @{u.username} · {u.role} ·{" "}
                            {u.enabled ? "Active" : "Suspended"}
                          </p>
                        </div>
                        <span>{u.balance} credits</span>
                        {dashboard.user.role === "admin" &&
                          u.role === "member" && (
                            <Button
                              variant="secondary"
                              disabled={busy}
                              aria-label={`${u.enabled ? "Suspend" : "Enable"} ${u.displayName}`}
                              onClick={() =>
                                void action(async () => {
                                  await request(
                                    "/users/" + u.id + "/status",
                                    "POST",
                                    { enabled: !u.enabled },
                                  );
                                  await refresh();
                                  setNotice(
                                    `${u.displayName} ${u.enabled ? "suspended" : "enabled"}.`,
                                  );
                                })
                              }
                            >
                              {u.enabled ? "Suspend" : "Enable"}
                            </Button>
                          )}
                      </li>
                    ))}
                  </ul>
                </Panel>
                <Panel>
                  <h2>Audit trail</h2>
                  <ol className="team-history">
                    {admin.events.map((e) => (
                      <li key={e.id}>
                        <div>
                          <strong>
                            {e.actor ?? "System"} ·{" "}
                            {e.action.replaceAll("_", " ")}
                          </strong>
                          <p className="muted">
                            {new Date(e.createdAt).toLocaleString()}
                          </p>
                          {e.subject && <code>{e.subject}</code>}
                        </div>
                      </li>
                    ))}
                  </ol>
                  <p className="muted small">
                    Latest 100 events. Login passwords are never included.
                  </p>
                </Panel>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
