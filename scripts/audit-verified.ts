import "./report-paths.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const exec = promisify(execFile),
  record = JSON.parse(await readFile("security-patches.json", "utf8")),
  patch = record.patches[0],
  bytes = await readFile(patch.path);
if (createHash("sha256").update(bytes).digest("hex") !== patch.sha256)
  throw new Error(
    "Security patch checksum changed; audit exception is invalid.",
  );
const require = createRequire(
    await realpath(resolve("contracts/node_modules/hardhat/package.json")),
  ),
  { z } = require("zod");
if (require("zod/package.json").version !== patch.version)
  throw new Error(
    "Hardhat validator version changed; review the patch record.",
  );
let visited = 0;
const element = z.preprocess((v: unknown) => {
  visited++;
  return v;
}, z.string());
for (const schema of [z.array(element).max(2), z.array(element).length(2)]) {
  const result = schema.safeParse(new Array(10000).fill(0));
  if (result.success || result.error.issues.length !== 1 || visited !== 0)
    throw new Error("Legacy array bound patch is absent.");
}
if (
  z
    .set(element)
    .max(2)
    .safeParse(new Set([1, 2, 3])).success ||
  visited
)
  throw new Error("Legacy set bound patch is absent.");
// The registry scanner is version-based and cannot recognize pnpm source patches.
// Exempt exactly this tested backport; every other advisory still fails the run.
let stdout:string;
try {
  stdout = (
    await exec("pnpm", ["audit", "--json"], { maxBuffer: 4 * 1024 * 1024 })
  ).stdout;
} catch (error) {
  if (
    !error ||
    typeof error !== "object" ||
    !("stdout" in error) ||
    typeof error.stdout !== "string"
  )
    throw error;
  stdout = error.stdout;
}
const audit = JSON.parse(stdout);
if (!audit.metadata || !audit.advisories)
  throw new Error(
    "Registry audit did not return a complete vulnerability report.",
  );
await writeFile(
  ".local/reports/dependency-audit-raw.json",
  JSON.stringify(audit, null, 2),
);
const unresolved = Object.values(audit.advisories).filter((entry) => {
  const advisory = entry as {
    module_name: string;
    cves?: string[];
    findings?: Array<{ version: string; paths: string[] }>;
  };
  return !(
    advisory.module_name === "zod" &&
    advisory.cves?.includes(patch.cve) &&
    advisory.findings?.length &&
    advisory.findings.every(
      (f) =>
        f.version === patch.version &&
        f.paths.every((path) => path.includes("hardhat")),
    )
  );
});
const result = {
  observedAt: new Date().toISOString(),
  unresolvedAdvisories: unresolved,
  registryAudit: audit,
  mitigatedAdvisories: [
    {
      cve: patch.cve,
      ghsa: patch.ghsa,
      package: "zod",
      version: patch.version,
      patch: patch.path,
      sha256: patch.sha256,
      behaviorVerified: true,
      scope:
        "Hardhat development tooling; application validators use Zod 4.6.7",
    },
  ],
};
await writeFile(
  ".local/reports/dependency-audit.json",
  JSON.stringify(result, null, 2),
);
if (unresolved.length)
  throw new Error(
    "Unresolved registry security advisories remain: " + unresolved.length,
  );
console.log(JSON.stringify(result, null, 2));
