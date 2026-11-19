import "./report-paths.ts";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

type Check = {
  name: string;
  args: string[];
  expectedExitCode?: number;
  env?: NodeJS.ProcessEnv;
};
type Result = {
  name: string;
  command: string;
  state: "passed" | "failed";
  exitCode: number;
  expectedExitCode: number;
  startedAt: string;
  completedAt: string;
  evidencePath: string;
};
const directory = ".local/reports/full-suite";
const exec = promisify(execFile);
async function applicationFingerprint() {
  const { stdout } = await exec("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "apps",
    "packages",
    "services",
    "contracts",
    "fixtures",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
  ]);
  const digest = createHash("sha256");
  for (const path of stdout.split("\0").filter(Boolean).sort()) {
    if (!existsSync(path)) continue;
    digest.update(path + "\0").update(await readFile(path));
  }
  return digest.digest("hex");
}
const checks: Check[] = [
  { name: "preflight", args: ["preflight"] },
  {
    name: "frozen-install",
    args: ["install", "--frozen-lockfile", "--offline"],
  },
  { name: "typecheck", args: ["typecheck"] },
  { name: "mobile-typecheck", args: ["mobile:typecheck"] },
  { name: "lint-and-boundaries", args: ["lint"] },
  { name: "unit-and-security", args: ["test:unit"] },
  { name: "contracts", args: ["contracts:test"] },
  { name: "dataset-before", args: ["seed:assert"] },
  { name: "web-build", args: ["build:wallet"] },
  { name: "web-ui-accessibility-responsive", args: ["test:ui"] },
  {
    name: "release-boundary",
    args: ["exec", "node", "scripts/check-release.mjs"],
  },
  { name: "core-browser", args: ["test:browser-core"] },
  {
    name: "evm-browser",
    args: [
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.chains.config.ts",
    ],
  },
  { name: "reference-build", args: ["build:dapp"] },
  {
    name: "evm-popup",
    args: [
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.dapp.config.ts",
    ],
  },
  { name: "accounts-and-rbac", args: ["test:accounts"] },
  { name: "backend-indexing-and-reorg", args: ["test:integration"] },
  ...[
    "pending-evm",
    "replacement-evm",
    "reverted-evm",
    "rpc-outage",
    "relayer-timeout",
  ].map((name) => ({
    name: "scenario-" + name,
    args: ["scenario", "--", name],
  })),
  { name: "solana-browser-and-popup", args: ["test:browser-solana"] },
  { name: "bitcoin-browser-and-popup", args: ["test:browser-bitcoin"] },
  { name: "native-chain-proofs", args: ["mobile:test:chains"] },
  {
    name: "seed-idempotence",
    args: ["exec", "tsx", "scripts/check-seed-idempotence.ts"],
  },
  { name: "dataset-after", args: ["seed:assert"] },
  { name: "network-identities", args: ["networks:check"] },
  {
    name: "live-market-observation",
    args: ["exec", "tsx", "scripts/check-market-live.ts"],
  },
  { name: "dependency-audit", args: ["audit:verified"] },
  {
    name: "native-dependency-compatibility",
    args: ["--filter", "@ewallet/mobile", "exec", "expo", "install", "--check"],
  },
  { name: "native-android-ios-bundles", args: ["mobile:export"] },
  {
    name: "android-debug-package",
    args: ["mobile:build:android"],
    env: {
      JAVA_HOME:
        process.env.JAVA_HOME ??
        (existsSync("/usr/lib/jvm/java-17-openjdk-amd64/bin/javac")
          ? "/usr/lib/jvm/java-17-openjdk-amd64"
          : undefined),
      ANDROID_HOME:
        process.env.ANDROID_HOME ?? join(homedir(), "Android", "Sdk"),
    },
  },
  {
    name: "deployment-configuration",
    args: [
      "exec",
      "docker",
      "compose",
      "--file",
      "infra/deployment/compose.yaml",
      "config",
      "--quiet",
    ],
    env: { EWALLET_DOMAIN: "wallet.example.invalid" },
  },
  { name: "testnet-build", args: ["build:testnet"] },
  {
    name: "testnet-release-boundary",
    args: ["exec", "node", "scripts/check-release.mjs"],
  },
  { name: "restore-local-build", args: ["build:wallet"] },
  {
    name: "real-funds-stay-disabled",
    args: ["release:check", "--require-ready"],
    expectedExitCode: 1,
  },
  {
    name: "development-startup",
    args: ["exec", "tsx", "scripts/check-dev.ts"],
  },
];

await mkdir(".local", { recursive: true });
await mkdir(directory + "/logs", { recursive: true });
const lock = await open(".local/full-suite.lock", "wx", 0o600).catch(() => {
  throw new Error(
    "A full-suite lock already exists. Stop the other run; remove a stale lock only after checking its PID.",
  );
});
await lock.writeFile(String(process.pid));
let startedAt = new Date().toISOString();
const results: Result[] = [];
const sourceFingerprint = await applicationFingerprint().catch(() => null);
const previousFailures: Result[] = [];
let state = "running";
async function report() {
  const observations: Record<string, unknown> = {};
  if (
    results.some((r) => r.name === "network-identities" && r.state === "passed")
  ) {
    observations.networks = JSON.parse(
      await readFile(".local/reports/chains/network-health.json", "utf8"),
    ).results;
  }
  if (
    results.some(
      (r) => r.name === "live-market-observation" && r.state === "passed",
    )
  ) {
    const markets = JSON.parse(
      await readFile(".local/reports/product/market-live-proof.json", "utf8"),
    );
    observations.market = {
      assets: markets.assets.length,
      stale: markets.stale,
      observedAt: markets.observedAt,
    };
  }
  if (
    results.some(
      (r) => r.name === "android-debug-package" && r.state === "passed",
    )
  ) {
    const path =
      "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk";
    const apk = await readFile(path);
    observations.androidPackage = {
      path,
      bytes: apk.length,
      sha256: createHash("sha256").update(apk).digest("hex"),
      requiresMetro: true,
    };
  }
  await writeFile(
    directory + "/report.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        startedAt,
        updatedAt: new Date().toISOString(),
        state,
        scope:
          "Complete automated local application regression; manual/device and public-funding limits remain separate",
        totalChecks: checks.length,
        passedChecks: results.filter((r) => r.state === "passed").length,
        failedChecks: results.filter((r) => r.state === "failed").length,
        realFundsEnabled: false,
        sourceFingerprint,
        previousFailures,
        checks: results,
        observations,
        notExecuted: [
          {
            check:
              "Android physical-device acceptance and camera/Keystore/privacy behavior",
            reason:
              "Requires a connected physical Android device; APK compilation and native-core proofs are separate checks.",
          },
          {
            check: "iOS native binary and physical-device acceptance",
            reason:
              "Requires macOS/Xcode and an iPhone; exported Hermes bundles are checked here.",
          },
          {
            check: "Public-testnet funded transactions",
            reason:
              "Requires funded random test identities; RPC identity observations do not prove a funded send.",
          },
          {
            check: "Mainnet/client launch",
            reason: "Deferred by the user; no real funds enabled or sent.",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
}
try {
  if (process.argv.includes("--resume")) {
    const previous = JSON.parse(
      await readFile(directory + "/report.json", "utf8"),
    );
    if (!sourceFingerprint || previous.sourceFingerprint !== sourceFingerprint)
      throw new Error(
        "Application source or dependencies changed. Run the full suite without --resume.",
      );
    startedAt = previous.startedAt;
    previousFailures.push(...(previous.previousFailures ?? []));
    for (const row of previous.checks as Result[]) {
      if (row.state !== "passed") {
        const archivedPath = `${directory}/logs/${row.name}-failed-${previousFailures.length + 1}.log`;
        await copyFile(row.evidencePath, archivedPath);
        previousFailures.push({ ...row, evidencePath: archivedPath });
        break;
      }
      const check = checks[results.length];
      if (!check || row.command !== "pnpm " + check.args.join(" "))
        throw new Error("The suite changed. Run again without --resume.");
      results.push(row);
    }
  }
  if (process.env.EWALLET_MODE && process.env.EWALLET_MODE !== "local")
    throw new Error("Run the full local suite in local mode.");
  for (const port of [5173, 5174, 8787, 8877, 8081]) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (!free)
      throw new Error(
        `Port ${port} is occupied. Stop development, Metro and other test servers first.`,
      );
  }
  await report();
  for (const check of checks) {
    if (
      results.some((row) => row.name === check.name && row.state === "passed")
    )
      continue;
    console.log(`[${results.length + 1}/${checks.length}] ${check.name}`);
    const path = `${directory}/logs/${check.name}.log`;
    const file = await open(path, "w");
    const stepStartedAt = new Date().toISOString();
    let code: number;
    try {
      code = await new Promise<number>((resolve, reject) => {
        const child = spawn("pnpm", check.args, {
          stdio: ["ignore", file.fd, file.fd],
          env: {
            ...process.env,
            NODE_ENV: "test",
            EWALLET_MODE: "local",
            EWALLET_ACCOUNTS: "0",
            CI: "1",
            PLAYWRIGHT_NO_COPY_PROMPT: "1",
            ...check.env,
          },
        });
        child.once("error", reject);
        child.once("exit", (exitCode) => resolve(exitCode ?? 1));
      });
    } finally {
      await file.close();
    }
    const expected = check.expectedExitCode ?? 0;
    results.push({
      name: check.name,
      command: "pnpm " + check.args.join(" "),
      state: code === expected ? "passed" : "failed",
      exitCode: code,
      expectedExitCode: expected,
      startedAt: stepStartedAt,
      completedAt: new Date().toISOString(),
      evidencePath: path,
    });
    await report();
    if (code !== expected)
      throw new Error(`${check.name} failed. See ${path}.`);
  }
  state = "passed";
  console.log(
    "All automated local checks passed. See .local/reports/full-suite/report.json for exact scope and device limits.",
  );
} catch (error) {
  state = "failed";
  console.error(
    error instanceof Error ? error.message : "Full verification failed.",
  );
  process.exitCode = 1;
} finally {
  await report();
  await lock.close();
  await unlink(".local/full-suite.lock");
}
