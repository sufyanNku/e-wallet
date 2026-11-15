import { spawn } from "node:child_process";
import { mkdir, open, writeFile, readFile } from "node:fs/promises";
const checks = [
  ["typecheck", ["typecheck"]],
  ["lint", ["lint"]],
  ["unit", ["test:unit"]],
  ["contracts", ["contracts:test"]],
  ["build-wallet", ["build:wallet"]],
  ["core-browser", ["test:browser-core"]],
  [
    "evm-browser",
    ["exec", "playwright", "test", "--config", "playwright.chains.config.ts"],
  ],
  [
    "evm-dapp",
    ["exec", "playwright", "test", "--config", "playwright.dapp.config.ts"],
  ],
  ["solana-browser", ["test:browser-solana"]],
  ["bitcoin-browser", ["test:browser-bitcoin"]],
  ["integration", ["test:integration"]],
  ["seed-assert", ["seed:assert"]],
  ["network-health", ["networks:check"]],
  ["audit", ["audit:verified"]],
] as const;
await mkdir("artifacts/phase-04", { recursive: true });
const results: Array<{
  command: string;
  state: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  evidencePath: string;
}> = [];
if (process.argv.includes("--resume")) {
  try {
    const previous = JSON.parse(
      await readFile("artifacts/phase-04/final-verification.json", "utf8"),
    );
    results.push(
      ...previous.checks.filter((c: { state: string }) => c.state === "passed"),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
for (const [name, args] of checks) {
  if (results.some((c) => c.command === "pnpm " + args.join(" "))) continue;
  const path = "artifacts/phase-04/final-" + name + ".log",
    file = await open(path, "w"),
    startedAt = new Date().toISOString();
  console.log("Checking " + name + "…");
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn("pnpm", [...args], {
      stdio: ["ignore", file.fd, file.fd],
      env: { ...process.env, PLAYWRIGHT_NO_COPY_PROMPT: "1" },
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  await file.close();
  results.push({
    command: "pnpm " + args.join(" "),
    state: code === 0 ? "passed" : "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: code,
    evidencePath: path,
  });
  await writeFile(
    "artifacts/phase-04/final-verification.json",
    JSON.stringify(
      { scope: "Implementation files 01–04", checks: results },
      null,
      2,
    ),
  );
  if (code !== 0)
    throw new Error("Verification failed at " + name + "; inspect " + path);
  console.log(name + " passed.");
}
