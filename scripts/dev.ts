import { spawn, type ChildProcess } from "node:child_process";
import { currentEpoch } from "../services/backend/src/environment";
import { readFile } from "node:fs/promises";
import { DevPorts, preferredPort } from "./dev-ports.ts";

const children: ChildProcess[] = [];
const ports = new DevPorts();
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
  void ports.close();
  process.exitCode = code;
}
function launch(args: string[], env: NodeJS.ProcessEnv) {
  if (stopping) return;
  const child = spawn("pnpm", args, {
    stdio: "inherit",
    env,
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.once("error", () => stop(1));
  child.once("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => stop());

async function start() {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Use Node 24 from .nvmrc.");
  for (const id of ["eip155:31337", "eip155:31338"]) {
    try {
      const epoch = await currentEpoch(id),
        manifest = JSON.parse(
          await readFile(
            ".local/state/deployments/" + id.replace(":", "-") + ".json",
            "utf8",
          ),
        );
      if (epoch.bootEpoch !== manifest.bootEpoch)
        console.log(id + ": needs_seed. Run pnpm seed:local.");
    } catch {
      console.log(
        id +
          ": node or seed unavailable. Run pnpm infra:up and pnpm seed:local for local execution.",
      );
    }
    if (stopping) return;
  }
  const built = await readFile(
    "apps/wallet/dist/wallet-config.json",
    "utf8",
  ).catch(() => "{}");
  if (JSON.parse(built).mode !== "local")
    await new Promise<void>((resolve, reject) => {
      const child = spawn("pnpm", ["build:wallet"], {
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      children.push(child);
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Wallet build failed")),
      );
    });
  if (stopping) return;

  const backend = await ports.reserve(preferredPort(process.env.PORT, 8787));
  const wallet = await ports.reserve(
    preferredPort(process.env.EWALLET_WALLET_PORT, 5173),
  );
  const reference =
    process.argv[2] === "wallet"
      ? null
      : await ports.reserve(preferredPort(process.env.EWALLET_DAPP_PORT, 5174));
  if (stopping) return;
  const origin = (port: number) => "http://127.0.0.1:" + port;
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(backend),
    EWALLET_WALLET_PORT: String(wallet),
    ...(reference === null ? {} : { EWALLET_DAPP_PORT: String(reference) }),
    EWALLET_PUBLIC_ORIGINS: [
      ...new Set([
        origin(backend),
        origin(wallet),
        ...(process.env.EWALLET_PUBLIC_ORIGINS?.split(",")
          .map((value) => value.trim())
          .filter(Boolean) ?? []),
      ]),
    ].join(","),
    VITE_EWALLET_API_URL: origin(backend),
    VITE_EWALLET_APPROVAL_URL: origin(backend),
    VITE_EWALLET_WALLET_URL: origin(wallet),
  };
  await ports.release(backend);
  launch(["serve:web"], env);
  await ports.release(wallet);
  launch(
    [
      "exec",
      "vite",
      "--config",
      "apps/wallet/vite.config.ts",
      "--mode",
      "wallet-local",
    ],
    env,
  );
  if (reference !== null) {
    await ports.release(reference);
    launch(["dev:dapp"], env);
    launch(["relayer", "--watch"], env);
  }
  console.log(
    "Open your wallet: " +
      origin(wallet) +
      (reference === null
        ? ""
        : "\nDeveloper reference dapp (connection tests): " +
          origin(reference)) +
      "\nBackend and built approval windows: " +
      origin(backend) +
      "\nExisting nodes are used without reset or reseeding.",
  );
  if (process.env.EWALLET_ACCOUNTS === "1")
    console.log("Account logins and RBAC: " + origin(wallet) + "/accounts");
}
try {
  await start();
} catch (error) {
  if (!stopping)
    console.error(
      error instanceof Error ? error.message : "Development startup failed.",
    );
  stop(1);
} finally {
  await ports.close();
}
