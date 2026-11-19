import "./report-paths.ts";
import { spawn } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
const log = await open(".local/dev-smoke.log", "w"),
  child = spawn("pnpm", ["dev"], {
    stdio: ["ignore", log.fd, log.fd],
    detached: true,
  });
let exited = false;
child.once("exit", () => {
  exited = true;
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (exited)
      throw new Error("Development supervisor exited before readiness");
    try {
      const responses = await Promise.all(
        [8787, 5173, 5174].map((port) =>
          fetch(
            "http://127.0.0.1:" +
              port +
              (port === 8787 ? "/api/v1/health" : "/"),
            { signal: AbortSignal.timeout(1000) },
          ),
        ),
      );
      if (responses.every((r) => r.ok)) {
        const health = await responses[0].json();
        if (
          health.data.service !== "e-wallet" ||
          health.data.frontendMode !== "local"
        )
          throw new Error("Unexpected application host");
        ready = true;
        break;
      }
    } catch {
      /* Bounded owned-process startup polling. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("Development stack did not become ready");
  const connect = await fetch("http://127.0.0.1:8787/connect"),
    normal = await fetch("http://127.0.0.1:8787/");
  if (
    connect.headers.get("cross-origin-opener-policy") !== "unsafe-none" ||
    normal.headers.get("cross-origin-opener-policy") !== "same-origin" ||
    !connect.headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'")
  )
    throw new Error("Approval security headers differ");
  await writeFile(
    ".local/reports/integration/dev-supervisor-proof.json",
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        wallet: 5173,
        backendAndApprovals: 8787,
        referenceDapp: 5174,
        ready: true,
        localMode: true,
        openerPoliciesVerified: true,
        scope: "Only spawned development processes; existing nodes retained",
      },
      null,
      2,
    ),
  );
  console.log(
    "Development supervisor starts wallet/backend/reference dapp and serves the required opener policies.",
  );
} finally {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* Owned process already exited. */
    }
  }
  await log.close();
}
