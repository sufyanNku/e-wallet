import { spawn, execFile } from "node:child_process";
import { mkdir, chmod, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { bitcoinIdentity } from "../services/backend/src/bitcoin-rpc";
const exec = promisify(execFile),
  compose = [
    "compose",
    "--project-name",
    "ewallet-bitcoin-browser-test",
    "--file",
    "infra/compose.bitcoin-browser.yaml",
  ];
process.env.EWALLET_ISOLATED_BITCOIN_TEST = "1";
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(command + " failed (" + code + ")")),
    );
  });
}
await mkdir(".local/secrets/bitcoin-browser", { recursive: true, mode: 0o700 });
await chmod(".local/secrets/bitcoin-browser", 0o700);
await run("docker", [...compose, "down"]);
try {
  await run("pnpm", ["build:wallet"]);
  await run("docker", [...compose, "up", "-d", "--no-build"]);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      await bitcoinIdentity();
      ready = true;
      break;
    } catch {
      /* Fixed test endpoint startup polling. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("Isolated regtest node did not become ready.");
  const { stdout } = await exec("docker", [
    "inspect",
    "--format",
    '{{index .Config.Labels "org.ewallet.project"}}',
    "ewallet-bitcoin-browser-test-bitcoin-1",
  ]);
  if (stdout.trim() !== "ewallet-bitcoin-browser-test")
    throw new Error("Unrecognized test container");
  await run("pnpm", ["seed:bitcoin"]);
  if (!process.argv.includes("--native-only")) {
    await run("pnpm", [
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.bitcoin.config.ts",
    ]);
    await run("pnpm", [
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.dapp-bitcoin.config.ts",
    ]);
  }
  if(process.argv.includes("--native-only")) await run("pnpm", [
    "exec",
    "tsx",
    "scripts/check-native-wallet.ts",
    "--family=bitcoin",
  ]);
  await writeFile(
    "artifacts/phase-03/bitcoin-browser-cleanup.json",
    JSON.stringify({
      project: "ewallet-bitcoin-browser-test",
      mainLedgerTouched: false,
      completedAt: new Date().toISOString(),
    }),
  );
} finally {
  await run("docker", [...compose, "down"]);
}
