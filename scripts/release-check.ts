import { readFile, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
const config = z
  .object({
    schemaVersion: z.literal(1),
    realFundsRequested: z.boolean(),
    checks: z
      .object({
        independentSecurityAudit: z.boolean(),
        mainnetAdapterAcceptance: z.boolean(),
        mainnetVaultIsolation: z.boolean(),
        productionRpcAndIndexer: z.boolean(),
        restoreAndIncidentDrill: z.boolean(),
        androidPhysicalDeviceAcceptance: z.boolean(),
        iosPhysicalDeviceAcceptance: z.boolean(),
        clientPrivacyAndTermsApproval: z.boolean(),
        storeSigningAndDistribution: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .parse(JSON.parse(await readFile("release-config.json", "utf8")));
const blockers = Object.entries(config.checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
const result = {
  observedAt: new Date().toISOString(),
  target: "Real-fund public launch",
  requested: config.realFundsRequested,
  enabled: false,
  ready: blockers.length === 0,
  blockers,
  activation:
    "Mainnet remains disabled in the current adapters and vaults. Configuration booleans record release review and never bypass implementation.",
};
await mkdir("artifacts/product", { recursive: true });
await writeFile(
  "artifacts/product/release-readiness.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  result.ready
    ? "Release evidence is recorded; mainnet implementation must still be enabled explicitly."
    : "Real funds disabled. Outstanding release checks: " + blockers.join(", "),
);
if (
  process.argv.includes("--require-ready") &&
  (!result.ready || !config.realFundsRequested)
)
  process.exitCode = 1;
