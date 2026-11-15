import { observeBridge } from "./bridge-observer";
import { localManifestSchema } from "../../../packages/domain/src/local-manifest";
import { registerReadApi } from "./read-api";
import { registerMetadata } from "./metadata";
import { registerWatchApi } from "./watch-api";
import { registerBitcoinWatch } from "./bitcoin-watch";
import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { registerSessions } from "./sessions";
import { registerRpc } from "./rpc";
import { registerEnvironment } from "./environment";

export async function buildServer(options: { databasePath?: string } = {}) {
  const frontendConfig = fileURLToPath(
    new URL("../../../apps/wallet/dist/wallet-config.json", import.meta.url),
  );
  const frontendMode = existsSync(frontendConfig)
    ? (JSON.parse(readFileSync(frontendConfig, "utf8")) as { mode: string })
        .mode
    : "unbuilt";
  const app = Fastify({
    logger: false,
    bodyLimit: 262144,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.setErrorHandler((error, req, reply) => {
    const status =
      error && typeof error === "object" && "statusCode" in error
        ? error.statusCode
        : 500;
    const code =
      typeof status === "number" && status >= 400 && status < 500
        ? status
        : 500;
    reply.code(code).send({
      error: {
        code: code === 400 ? "BAD_REQUEST" : "SERVICE_ERROR",
        message:
          code === 400
            ? "The request does not match the supported schema."
            : "The service request could not be completed.",
        correlationId: req.id,
      },
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    if (!["127.0.0.1:8787", "127.0.0.1:5173"].includes(req.headers.host ?? ""))
      return reply.code(403).send({
        error: {
          code: "HOST",
          message: "Unrecognized host",
          correlationId: req.id,
        },
      });
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    reply.header(
      "Cross-Origin-Opener-Policy",
      req.url.split("?")[0] === "/connect" ? "unsafe-none" : "same-origin",
    );
    reply.header(
      "Cache-Control",
      req.url.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
  });
  const sessions = await registerSessions(
    app,
    options.databasePath ??
      (process.env.EWALLET_ISOLATED_SOLANA_TEST === "1"
        ? ".local/browser-solana/backend.sqlite"
        : process.env.EWALLET_ISOLATED_BITCOIN_TEST === "1"
          ? ".local/browser-bitcoin/backend.sqlite"
          : `.local/${process.env.EWALLET_MODE ?? "local"}/backend.sqlite`),
  );
  await registerBitcoinWatch(app, sessions.db, sessions.session);
  const indexer = await registerWatchApi(app, sessions.db, sessions.session);
  registerReadApi(app, sessions.db, sessions.session, indexer);
  await registerMetadata(app, sessions.db);
  await registerRpc(app);
  await registerEnvironment(app);
  for (const path of ["manifest", "testnets"])
    app.get("/api/v1/demo/" + path, async (req, reply) => {
      if (frontendMode !== "local" || process.env.EWALLET_MODE === "testnet")
        return reply
          .code(404)
          .send({
            error: {
              code: "DEMO_DISABLED",
              message: "Local evaluation data is disabled.",
              correlationId: req.id,
            },
          });
      try {
        const file =
            path === "manifest"
              ? "artifacts/seed/local-manifest.json"
              : "artifacts/seed/testnet-manifest.json",
          raw = JSON.parse(readFileSync(file, "utf8")),
          data = path === "manifest" ? localManifestSchema.parse(raw) : raw;
        reply.header("Cache-Control", "no-store");
        return { data, meta: { source: "recorded-node-evidence" } };
      } catch {
        return reply
          .code(503)
          .send({
            error: {
              code: "NEEDS_SEED",
              message: "Run the documented local seed/evidence command.",
              correlationId: req.id,
            },
          });
      }
    });
  app.get("/api/v1/bridge/status", async (req, reply) => {
    if (frontendMode !== "local")
      return reply
        .code(404)
        .send({
          error: {
            code: "LOCAL_ONLY",
            message: "Bridge simulation is local only.",
            correlationId: req.id,
          },
        });
    try {
      return { data: await observeBridge(), meta: { source: "node" } };
    } catch {
      return reply
        .code(503)
        .send({
          error: {
            code: "BRIDGE_UNAVAILABLE",
            message: "The local bridge pair is unavailable or needs reseeding.",
            correlationId: req.id,
          },
        });
    }
  });
  app.get("/api/v1/health", async () => ({
    data: { service: "e-wallet", version: "0.1.0", ready: true, frontendMode },
    meta: { observedAt: new Date().toISOString() },
  }));
  const root = fileURLToPath(
    new URL("../../../apps/wallet/dist", import.meta.url),
  );
  if (existsSync(root)) {
    await app.register(staticFiles, { root });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === "GET" &&
        !req.url.startsWith("/api/") &&
        !req.url.split("?")[0].split("/").at(-1)?.includes(".")
      )
        return reply.sendFile("index.html");
      return reply.code(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Route not found",
          correlationId: req.id,
        },
      });
    });
  }
  return app;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await buildServer();
  await app.listen({ host: "127.0.0.1", port: 8787 });
  console.log("e-wallet evaluation host: http://127.0.0.1:8787");
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
}
