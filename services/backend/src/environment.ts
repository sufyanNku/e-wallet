import { solanaManifestSchema } from "@ewallet/domain";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { networkById } from "@ewallet/config";
import { deploymentSchema } from "@ewallet/domain/deployments";
const exec = promisify(execFile);
export async function currentEpoch(networkId: string) {
  const service =
    networkId === "eip155:31337"
      ? "evm-a"
      : networkId === "eip155:31338"
        ? "evm-b"
        : null;
  if (!service) throw new Error("Not a local ephemeral EVM chain");
  const { stdout: id } = await exec(
    "docker",
    [
      "compose",
      "--project-name",
      "ewallet-demo",
      "--file",
      "infra/compose.yaml",
      "ps",
      "-q",
      service,
    ],
    { timeout: 5000 },
  );
  if (!id.trim()) throw new Error("Node is not running");
  const { stdout } = await exec(
    "docker",
    ["inspect", "--format", "{{json .State.StartedAt}}", id.trim()],
    { timeout: 5000 },
  );
  return {
    bootEpoch: createHash("sha256")
      .update(id.trim() + stdout)
      .digest("hex"),
    startedAt: JSON.parse(stdout) as string,
  };
}
export async function registerEnvironment(app: FastifyInstance) {
  app.get("/api/v1/solana/registry", async (req, reply) => {
    try {
      const manifest = solanaManifestSchema.parse(
        JSON.parse(
          await readFile(
            process.env.EWALLET_ISOLATED_SOLANA_TEST === "1"
              ? ".local/reports/chains/isolated-solana-manifest.json"
              : ".local/state/seed/solana-manifest.json",
            "utf8",
          ),
        ),
      );
      reply.header("Cache-Control", "no-store");
      return {
        data: { genesisHash: manifest.genesisHash, mints: manifest.mints },
      };
    } catch {
      return reply.code(503).send({
        error: {
          code: "NEEDS_SEED",
          message: "Local Solana registry is unavailable.",
          correlationId: req.id,
        },
      });
    }
  });
  app.get("/api/v1/solana/environment", async (req, reply) => {
    try {
      const data = JSON.parse(
        await readFile(
          process.env.EWALLET_ISOLATED_SOLANA_TEST === "1"
            ? ".local/reports/chains/isolated-solana-manifest.json"
            : ".local/state/seed/solana-manifest.json",
          "utf8",
        ),
      );
      const genesisHash = String(data.genesisHash);
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesisHash))
        throw new Error("Invalid genesis");
      return { data: { genesisHash } };
    } catch {
      return reply.code(503).send({
        error: {
          code: "NEEDS_SEED",
          message: "Local Solana is not seeded.",
          correlationId: req.id,
        },
      });
    }
  });
  app.get("/api/v1/environment/:network", async (req, reply) => {
    try {
      const id = (req.params as { network: string }).network;
      networkById(id);
      const environment = await currentEpoch(id);
      reply.header("Cache-Control", "no-store");
      return {
        data: { networkId: id, ...environment },
        meta: { observedAt: new Date().toISOString() },
      };
    } catch {
      return reply.code(503).send({
        error: {
          code: "ENVIRONMENT_UNAVAILABLE",
          message: "The local node environment is unavailable.",
          correlationId: req.id,
        },
      });
    }
  });
  app.get("/api/v1/deployments/:network", async (req, reply) => {
    try {
      const id = (req.params as { network: string }).network;
      networkById(id);
      const data = deploymentSchema.parse(
        JSON.parse(
          await readFile(
            `.local/state/deployments/${id.replace(":", "-")}.json`,
            "utf8",
          ),
        ),
      );
      reply.header("Cache-Control", "no-store");
      return { data, meta: { observedAt: new Date().toISOString() } };
    } catch {
      return reply.code(404).send({
        error: {
          code: "NO_DEPLOYMENT",
          message: "No verified deployment manifest is available.",
          correlationId: req.id,
        },
      });
    }
  });
}
