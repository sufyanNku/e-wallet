import { displayNetworkName } from "@ewallet/domain";
import { useEffect, useState } from "react";
import { Button, Notice, PageTitle, Panel, Address } from "@ewallet/ui";
import { networkById } from "@ewallet/config";
import { z } from "zod";
const manifestSchema = z.object({
    runId: z.string(),
    createdAt: z.string(),
    warning: z.string(),
    scenarios: z.array(
      z.object({
        id: z.string(),
        networkId: z.string(),
        identifier: z.string(),
        state: z.string(),
        evidenceStatus: z.enum(["live", "pruned"]),
      }),
    ),
    assertions: z.object({ state: z.string() }),
  }),
  healthSchema = z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      stale: z.boolean(),
      health: z.object({
        state: z.string(),
        observed: z.string().nullable(),
        observedAt: z.string().nullable(),
      }),
    }),
  ),
  testnetsSchema = z.object({
    observedAt: z.string(),
    results: z.array(
      z.object({
        networkId: z.string(),
        state: z.string(),
        address: z.string(),
        reason: z.string().optional(),
      }),
    ),
  });
export function RealEvaluation() {
  const [manifest, setManifest] = useState<z.infer<typeof manifestSchema> | null>(
      null,
    ),
    [health, setHealth] = useState<z.infer<typeof healthSchema>>([]),
    [testnets, setTestnets] = useState<z.infer<typeof testnetsSchema> | null>(
      null,
    ),
    [error, setError] = useState("");
  async function refresh() {
    setError("");
    const read = async (path: string) => {
      const response = await fetch("/api/v1/" + path, { cache: "no-store" });
      if (!response.ok)
        throw new Error("Evidence unavailable. Run the relevant seed command.");
      return (await response.json()).data;
    };
    const results = await Promise.allSettled([
      read("environment/manifest").then((v) => setManifest(manifestSchema.parse(v))),
      read("networks").then((v) => setHealth(healthSchema.parse(v))),
      read("environment/testnets").then((v) => setTestnets(testnetsSchema.parse(v))),
    ]);
    if (results.some((r) => r.status === "rejected"))
      setError(
        "Some recorded evidence is unavailable for this build. Public-network execution remains pending unless its own row passed.",
      );
  }
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <>
      <PageTitle
        title="Network status"
        description="Network connections and recent observations."
      />
      <Button variant="secondary" onClick={() => void refresh()}>
        Refresh evidence
      </Button>
      {error && <Notice>{error}</Notice>}
      <div className="content-grid">
        <Panel>
          <h2>Execution records</h2>
          {manifest ? (
            <>
              <dl className="details">
                <dt>Run ID</dt>
                <dd>{manifest.runId}</dd>
                <dt>Recorded</dt>
                <dd>{manifest.createdAt}</dd>
                <dt>Verified stages</dt>
                <dd>{manifest.scenarios.length}</dd>
                <dt>Assertions</dt>
                <dd>{manifest.assertions.state}</dd>
                <dt>Historical availability</dt>
                <dd>
                  {
                    manifest.scenarios.filter(
                      (s) => s.evidenceStatus === "pruned",
                    ).length
                  }{" "}
                  archived signatures are pruned from this validator; current
                  holdings were checked independently.
                </dd>
              </dl>
              <details>
                <summary>Recorded transaction identifiers</summary>
                {manifest.scenarios.map((stage) => (
                  <div
                    className="network-diagnostic"
                    key={stage.networkId + stage.id}
                  >
                    <strong>{stage.id}</strong>
                    <span>
                      {displayNetworkName(networkById(stage.networkId))} · {stage.state} ·{" "}
                      {stage.evidenceStatus}
                    </span>
                    <Address value={stage.identifier} />
                  </div>
                ))}
              </details>
            </>
          ) : (
            <p>No local manifest available. Run pnpm seed:local.</p>
          )}
        </Panel>
        <Panel>
          <h2>Network health</h2>
          <p className="muted">
            A matching RPC identity does not prove a funded send. Refresh after
            the first background probe completes.
          </p>
          {health.map((n) => (
            <div className="network-diagnostic" key={n.id}>
              <strong>{displayNetworkName(n)}</strong>
              <span>
                {n.health.state}
                {n.stale ? " · stale" : ""}
              </span>
              <small>{n.health.observedAt ?? "Probe pending"}</small>
            </div>
          ))}
        </Panel>
      </div>
      <Panel>
        <h2>Network execution</h2>
        {testnets ? (
          <>
            <p>
              Observed {testnets.observedAt}.
            </p>
            {testnets.results.map((r) => (
              <div className="permission-row" key={r.networkId}>
                <div>
                  <strong>
                    {displayNetworkName(networkById(r.networkId))} ·{" "}
                    {r.state.replaceAll("_", " ")}
                  </strong>
                  <p>
                    {r.state === "blocked_funding" ? "Awaiting network funding." : "See the recorded network receipts for details."}
                  </p>
                  <Address value={r.address} />
                </div>
              </div>
            ))}
          </>
        ) : (
          <p>Network execution records are not available yet.</p>
        )}
      </Panel>
    </>
  );
}
