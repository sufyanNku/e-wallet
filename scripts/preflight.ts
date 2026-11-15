import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access, statfs, writeFile, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { freemem, totalmem } from "node:os";
const exec = promisify(execFile);
export async function preflight() {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Use the pinned Node 24 toolchain (.nvmrc).");
  const { stdout: pnpm } = await exec("pnpm", ["--version"]);
  if (!pnpm.trim().startsWith("10."))
    throw new Error("Use pnpm 10 from packageManager.");
  await exec("docker", ["version"]);
  await exec("docker", ["compose", "version"]);
  await mkdir(".local", { recursive: true });
  await access(".local");
  const probe = ".local/.write-probe-" + process.pid;
  await writeFile(probe, "ok", { flag: "wx" });
  await unlink(probe);
  const disk = await statfs("."),
    free = Number(disk.bavail) * Number(disk.bsize);
  if (free < 2 * 1024 ** 3)
    throw new Error(
      "Less than 2 GiB disk space remains; free local space before starting nodes.",
    );
  const ports: Record<string, string> = {};
  for (const port of [5173, 5174, 8787, 8545, 8546, 8899, 8900, 18443])
    ports[port] = await new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve("occupied"));
      server.listen(port, "127.0.0.1", () =>
        server.close(() => resolve("available")),
      );
    });
  return {
    observedAt: new Date().toISOString(),
    node: process.version,
    pnpm: pnpm.trim(),
    docker: true,
    compose: true,
    freeDiskBytes: String(free),
    ramBytes: String(totalmem()),
    freeRamBytes: String(freemem()),
    recommended: { ramGiB: 16, diskGiB: 25 },
    resourceNote:
      totalmem() < 16 * 1024 ** 3 || free < 25 * 1024 ** 3
        ? "Sequential chain browser test commands are available; full-stack resources are below the recommendation."
        : "Full-stack recommendation met.",
    ports,
    secureOrigins: ["http://127.0.0.1:5173", "http://127.0.0.1:8787"],
    mode: "local",
  };
}
if (process.argv[1]?.endsWith("/preflight.ts"))
  console.log(JSON.stringify(await preflight(), null, 2));
