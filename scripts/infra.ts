import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, chmod, writeFile, readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
const exec = promisify(execFile);
const compose = [
  "compose",
  "--project-name",
  "ewallet-demo",
  "--file",
  "infra/compose.yaml",
];
async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
if (process.argv[2] === "down") {
  await run("docker", [...compose, "down"]);
  process.exit(0);
}
if (process.argv[2] !== "up")
  throw new Error(
    "Use infra:up or infra:down. Destructive reset is a separate explicit command.",
  );
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Node 24 is required");
await exec("docker", ["version"]);
await exec("docker", ["compose", "version"]);
await mkdir(".local/secrets/bitcoin", { recursive: true, mode: 0o700 });
await chmod(".local/secrets/bitcoin", 0o700);
await run("pnpm", ["exec", "tsx", "scripts/install-native.ts"]);
await run("pnpm", ["exec", "tsx", "scripts/build-metadata.ts"]);
for (const [image, service] of [
  ["ewallet-hardhat:3.22.0", "evm-a"],
  ["ewallet-native:4.4.1-32.1", "solana"],
]) {
  let present = true;
  try {
    await exec("docker", ["image", "inspect", image]);
  } catch {
    present = false;
  }
  if (!present || process.argv.includes("--rebuild"))
    await run("docker", [...compose, "build", service]);
}
await run("docker", [...compose, "up", "-d", "--no-build"]);
const report: Record<string, unknown> = {
  schemaVersion: 1,
  runId: randomUUID(),
  observedAt: new Date().toISOString(),
  project: "ewallet-demo",
  networks: {},
};
const fingerprints: Record<string, unknown> = {};
for (const [service, networkId] of [
  ["evm-a", "eip155:31337"],
  ["evm-b", "eip155:31338"],
  ["solana", "solana:local"],
  ["bitcoin", "bitcoin:regtest"],
]) {
  const { stdout: id } = await exec("docker", [
    ...compose,
    "ps",
    "-q",
    service,
  ]);
  if (!id.trim()) throw new Error(`${service} did not start`);
  const { stdout } = await exec("docker", [
    "inspect",
    "--format",
    "{{json .State.StartedAt}}",
    id.trim(),
  ]);
  fingerprints[networkId] = {
    containerId: id.trim(),
    startedAt: JSON.parse(stdout),
    bootEpoch: createHash("sha256")
      .update(id.trim() + stdout)
      .digest("hex"),
  };
}
report.networks = fingerprints;
await mkdir(".local/infra", { recursive: true });
let previous: Record<string, unknown> = {};
try {
  previous = JSON.parse(await readFile(".local/infra/state.json", "utf8"));
} catch {
  /* First boot. */
}
await writeFile(
  ".local/infra/previous-state.json",
  JSON.stringify(previous, null, 2),
);
await writeFile(".local/infra/state.json", JSON.stringify(report, null, 2));
console.log(
  "Local chain processes started. Run pnpm networks:check for bounded identity/health checks, then seed:local.",
);
