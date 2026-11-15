import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  compose = [
    "compose",
    "--project-name",
    "ewallet-browser-test",
    "--file",
    "infra/compose.browser.yaml",
  ];
async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_NO_COPY_PROMPT: "1" },
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(command + " failed (" + code + ")")),
    );
  });
}
// This throwaway Compose project has no named volumes and never uses the demo ledger.
await run("docker", [...compose, "down"]);
try {
  await run("pnpm", ["build:wallet"]);
  await run("docker", [...compose, "up", "-d", "--no-build"]);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch("http://127.0.0.1:18899", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}',
        signal: AbortSignal.timeout(1000),
      });
      if (((await response.json()) as { result?: unknown }).result === "ok") {
        ready = true;
        break;
      }
    } catch {
      /* Bounded local-validator startup polling. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready)
    throw new Error("Isolated Solana validator did not become ready.");
  const { stdout: label } = await exec("docker", [
    "inspect",
    "--format",
    '{{index .Config.Labels "org.ewallet.project"}}',
    "ewallet-browser-test-solana-1",
  ]);
  if (label.trim() !== "ewallet-browser-test")
    throw new Error("Refusing unrecognized test container");
  await run("pnpm", [
    "exec",
    "tsx",
    "scripts/seed-solana.ts",
    "--isolated-browser-test",
  ]);
  process.env.EWALLET_ISOLATED_SOLANA_TEST = "1";
  await run("pnpm", ["exec", "tsx", "scripts/check-indexers.ts", "solana"]);
  await run("pnpm", [
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.solana.config.ts",
  ]);
  await run("pnpm", [
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.dapp-solana.config.ts",
  ]);
} finally {
  await run("docker", [...compose, "down"]);
}
