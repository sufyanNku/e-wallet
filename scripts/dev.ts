import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { currentEpoch } from "../services/backend/src/environment";
import { readFile } from "node:fs/promises";
const children: ChildProcess[] = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Owned child already exited. */
      }
    }
  }
  process.exitCode = code;
}
function launch(args: string[]) {
  const child = spawn("pnpm", args, {
    stdio: "inherit",
    env: process.env,
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.once("error", () => stop(1));
  child.once("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
async function available(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => stop());
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Use Node 24 from .nvmrc.");
for (const id of ["eip155:31337", "eip155:31338"]) {
  try {
    const epoch = await currentEpoch(id),
      manifest = JSON.parse(
        await readFile(
          "artifacts/deployments/" + id.replace(":", "-") + ".json",
          "utf8",
        ),
      );
    if (epoch.bootEpoch !== manifest.bootEpoch)
      console.log(id + ": needs_seed. Run pnpm seed:local.");
  } catch {
    console.log(
      id +
        ": node or seed unavailable. Run pnpm infra:up and pnpm seed:local for real local execution.",
    );
  }
}
if (!existsSync("apps/wallet/dist/wallet-config.json"))
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["build:wallet"], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Wallet build failed")),
    );
  });
if (await available(8787)) launch(["serve:web"]);
else {
  const response = await fetch("http://127.0.0.1:8787/api/v1/health", {
      signal: AbortSignal.timeout(2000),
    }),
    body = (await response.json()) as { data: { service: string } };
  if (!response.ok || body.data.service !== "e-wallet")
    throw new Error("Port 8787 belongs to another service.");
  console.log("Using the existing e-wallet backend.");
}
if (!(await available(5173))) {
  stop(1);
  throw new Error(
    "Port 5173 is occupied. Stop the existing development server first.",
  );
}
launch([
  "exec",
  "vite",
  "--config",
  "apps/wallet/vite.config.ts",
  "--mode",
  "wallet-local",
]);
if (process.argv[2] !== "wallet") {
  if (!(await available(5174))) {
    stop(1);
    throw new Error(
      "Port 5174 is occupied. Stop the existing reference dapp server first.",
    );
  }
  launch(["dev:dapp"]);
  launch(["relayer", "--watch"]);
}
console.log(
  "Wallet http://127.0.0.1:5173 · built approvals/backend http://127.0.0.1:8787 · reference dapp http://127.0.0.1:5174. Existing nodes are used without reset or reseeding.",
);
