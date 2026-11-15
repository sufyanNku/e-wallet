import { migrate } from "./migrations";
import Database from "better-sqlite3";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Session = { id: string; csrf_hash: string; expires_at: number };
const origins = ["http://127.0.0.1:8787", "http://127.0.0.1:5173"];
export async function registerSessions(app: FastifyInstance, path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const keyPath = dirname(path) + "/session-hmac.key";
  let hmacKey: Buffer;
  if (path === ":memory:") hmacKey = randomBytes(32);
  else {
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    hmacKey = readFileSync(keyPath);
  }
  const csrfFor = (token: string) =>
    createHmac("sha256", hmacKey).update(token).digest("base64url");
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrate(db);
  await app.register(cookie);
  await app.register(cors, {
    origin: origins,
    credentials: true,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  });
  await app.register(rateLimit, { max: 2400, timeWindow: "1 minute" });
  const exactOrigin = (req: FastifyRequest) =>
    origins.includes(req.headers.origin ?? "");
  const fetchMetadata = (req: FastifyRequest) =>
    ["same-origin", "same-site"].includes(
      req.headers["sec-fetch-site"] as string,
    );
  function session(req: FastifyRequest): Session | undefined {
    const token = req.cookies.ewallet_session;
    if (!token || token.length > 128) return;
    const row = db
      .prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?")
      .get(hash(token), Date.now()) as Session | undefined;
    return row;
  }
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/v1/")) return;
    const changing = ["POST", "DELETE", "PUT", "PATCH"].includes(req.method);
    if (
      changing &&
      (!exactOrigin(req) ||
        !fetchMetadata(req) ||
        !req.headers["content-type"]?.startsWith("application/json"))
    )
      return reply.code(403).send({
        error: {
          code: "ORIGIN",
          message: "This request must come from the wallet origin as JSON.",
          correlationId: req.id,
        },
      });
    if (changing && req.url.split("?")[0] !== "/api/v1/session") {
      const s = session(req),
        csrf = req.headers["x-csrf-token"];
      if (
        !s ||
        typeof csrf !== "string" ||
        csrf.length > 128 ||
        hash(csrf) !== s.csrf_hash
      )
        return reply.code(403).send({
          error: {
            code: "CSRF",
            message:
              "Re-establish the public watch session before changing it.",
            correlationId: req.id,
          },
        });
    }
  });
  app.post(
    "/api/v1/session",
    {
      schema: { body: { type: "object", additionalProperties: false } },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          groupId: "session-create",
        },
      },
    },
    async (req, reply) => {
      const active = session(req);
      if (active && req.cookies.ewallet_session)
        return {
          data: {
            csrfToken: csrfFor(req.cookies.ewallet_session),
            expiresAt: new Date(active.expires_at).toISOString(),
          },
          meta: { purpose: "Anonymous public watch data only" },
        };
      const token = randomBytes(32).toString("base64url"),
        csrf = csrfFor(token),
        expiresAt = Date.now() + 3600000;
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
      const old = session(req);
      if (old) db.prepare("DELETE FROM sessions WHERE id = ?").run(old.id);
      db.prepare(
        "INSERT INTO sessions(id,csrf_hash,expires_at) VALUES (?,?,?)",
      ).run(hash(token), hash(csrf), expiresAt);
      reply.setCookie("ewallet_session", token, {
        httpOnly: true,
        sameSite: "strict",
        secure: req.protocol === "https",
        path: "/api/v1",
        maxAge: 3600,
      });
      reply.header("Cache-Control", "no-store");
      return {
        data: { csrfToken: csrf, expiresAt: new Date(expiresAt).toISOString() },
        meta: { purpose: "Anonymous public watch data only" },
      };
    },
  );
  app.addHook("onClose", async () => {
    db.close();
  });
  return { db, session };
}
