import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  readdir,
  lstat,
  rm,
  mkdir,
  rename,
  realpath as realPath,
} from "node:fs/promises";
const exec = promisify(execFile),
  project = "ewallet-demo",
  root = await realPath(process.cwd()),
  compose = [
    "compose",
    "--project-name",
    project,
    "--file",
    "infra/compose.yaml",
  ];
if (!process.argv.includes("--confirm=ewallet-demo"))
  throw new Error(
    "Destructive local reset requires: pnpm reset:local -- --confirm=ewallet-demo. Browser vault storage is separate.",
  );
if (process.env.EWALLET_MODE && process.env.EWALLET_MODE !== "local")
  throw new Error("Only local reset is supported.");
try {
  const response = await fetch("http://127.0.0.1:8787/api/v1/health", {
    signal: AbortSignal.timeout(500),
  });
  if (response.ok)
    throw new Error(
      "Stop pnpm dev and the application server before resetting local state.",
    );
} catch (e) {
  if (e instanceof Error && e.message.startsWith("Stop pnpm")) throw e;
}
const { stdout: volumes } = await exec("docker", [
  "volume",
  "ls",
  "--filter",
  "label=com.docker.compose.project=" + project,
  "--format",
  "{{.Name}}",
]);
for (const name of volumes.trim().split("\n").filter(Boolean)) {
  if (
    ![
      "ewallet-demo_solana-metadata-data",
      "ewallet-demo_bitcoin-data",
      "ewallet-demo_solana-data",
    ].includes(name)
  )
    throw new Error("Unexpected project volume; audit before reset: " + name);
  const { stdout } = await exec("docker", [
    "volume",
    "inspect",
    "--format",
    "{{json .Labels}}",
    name,
  ]);
  const labels = JSON.parse(stdout);
  if (
    labels["com.docker.compose.project"] !== project ||
    labels["org.ewallet.project"] !== project
  )
    throw new Error("Volume ownership is not verified: " + name);
}
const { stdout: containers } = await exec("docker", [
  "ps",
  "-aq",
  "--filter",
  "label=com.docker.compose.project=" + project,
]);
for (const id of containers.trim().split("\n").filter(Boolean)) {
  const { stdout } = await exec("docker", [
    "inspect",
    "--format",
    "{{json .Config.Labels}}",
    id,
  ]);
  if (JSON.parse(stdout)["org.ewallet.project"] !== project)
    throw new Error("Unexpected container ownership.");
}
// Local journals and databases are fixed paths under this checkout. Refuse symlinks.
const local = resolve(root, ".local");
if ((await realPath(local)) !== local)
  throw new Error("Refusing symlinked local state.");
for (const name of [
  "local",
  "media-cache",
  "seed-journal.json",
  "seed-journal.json.tmp",
  ...(await readdir(local)).filter((n) =>
    /^seed-(31337|31338|solana|bitcoin)\.json(?:\.tmp)?$/.test(n),
  ),
]) {
  const path = resolve(local, name);
  if (!path.startsWith(local + "/"))
    throw new Error("Reset path escaped checkout");
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Refusing symlinked reset path");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
await exec("docker", [...compose, "down", "--volumes"]);
const archive = resolve(
  local,
  "reset-archive",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(archive, { recursive: true });
for (const name of [
  "local",
  "media-cache",
  "seed-journal.json",
  ...(await readdir(local)).filter((n) =>
    /^seed-(31337|31338|solana|bitcoin)\.json(?:\.tmp)?$/.test(n),
  ),
]) {
  try {
    await rename(resolve(local, name), resolve(archive, name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
for (const path of [
  ".local/state/seed/local-manifest.json",
  ".local/state/seed/evm-manifest.json",
  ".local/state/seed/solana-manifest.json",
  ".local/state/seed/bitcoin-manifest.json",
  ".local/state/deployments/eip155-31337.json",
  ".local/state/deployments/eip155-31338.json",
]) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(root + "/.local/state/"))
    throw new Error("Reset artifact path escaped");
  await rm(absolute, { force: true });
}
await new Promise<void>((resolve, reject) => {
  const child = spawn("pnpm", ["seed:local"], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0
      ? resolve()
      : reject(
          new Error("Fresh local seed failed; archived journals retained."),
        ),
  );
});
