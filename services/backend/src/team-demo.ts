import type Database from "better-sqlite3";
import { displayAccountName } from "@ewallet/domain";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { TeamRole } from "../../../packages/domain/src/team-demo";

export const teamDemoEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.EWALLET_TEAM_DEMO === "1" &&
  env.NODE_ENV !== "production" &&
  (env.EWALLET_MODE ?? "local") === "local" &&
  (!env.HOST || ["127.0.0.1", "localhost"].includes(env.HOST));

export function demoPasswordHash(
  password: string,
  salt: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const money = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
type User = {
  id: string;
  username: string;
  display_name: string;
  role: TeamRole;
  password_salt: string;
  password_hash: string;
  balance_cents: number;
  enabled: number;
  failed_logins: number;
  locked_until: number;
};
type PublicSession = {
  id: string;
  expires_at: number;
  client_kind: "browser" | "native";
};
const publicUser = (user: User) => ({
  id: user.id,
  username: user.username,
  displayName: displayAccountName(user.display_name),
  role: user.role,
});
const fail = (reply: FastifyReply, code: number, message: string) =>
  reply.code(code).send({ error: { code: "TEAM_DEMO", message } });
const cookieName = "ewallet_team_demo";
const cookiePath = "/api/v1/team-demo";
const prefix = "/api/v1/team-demo";
export function registerTeamDemo(
  app: FastifyInstance,
  db: Database.Database,
  publicSession: (req: FastifyRequest) => PublicSession | undefined,
  enabled = teamDemoEnabled(),
) {
  app.get(prefix + "/status", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { data: { enabled, unit: "Credits", realFundsEnabled: false } };
  });
  // Disabled by default, never enabled for a production/testnet service.
  if (!enabled) return;
  const audit = (
    actor: string | null,
    action: string,
    subject: string | null = null,
  ) =>
    db
      .prepare(
        "INSERT INTO team_demo_audit(actor_id,action,subject_id,created_at) VALUES (?,?,?,?)",
      )
      .run(actor, action, subject, new Date().toISOString());
  const find = (id: string) =>
    db.prepare("SELECT * FROM team_demo_users WHERE id=?").get(id) as
      | User
      | undefined;
  const authenticate = (
    req: FastifyRequest,
    reply: FastifyReply,
    roles?: TeamRole[],
  ) => {
    reply.header("Cache-Control", "no-store");
    const token = req.cookies[cookieName],
      session = publicSession(req);
    if (
      !token ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      session?.client_kind !== "browser"
    ) {
      fail(reply, 401, "Sign in to your account.");
      return;
    }
    const user = db
      .prepare(
        `SELECT u.* FROM team_demo_sessions s JOIN team_demo_users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.public_session_id=? AND s.expires_at>? AND u.enabled=1`,
      )
      .get(hash(token), session.id, Date.now()) as User | undefined;
    if (!user) {
      fail(
        reply,
        401,
        "Your session expired or this account is suspended. Sign in again.",
      );
      return;
    }
    if (roles && !roles.includes(user.role)) {
      fail(reply, 403, "Your role does not allow this action.");
      return;
    }
    return user;
  };
  app.post<{ Body: { username: string; password: string } }>(
    prefix + "/login",
    {
      config: {
        rateLimit: {
          max: 15,
          timeWindow: "1 minute",
          groupId: "team-demo-login",
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          additionalProperties: false,
          properties: {
            username: {
              type: "string",
              minLength: 1,
              maxLength: 64,
              pattern: "^[a-zA-Z0-9._-]+$",
            },
            password: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const session = publicSession(req);
      if (session?.client_kind !== "browser")
        return fail(reply, 403, "Use the browser to sign in.");
      const username = req.body.username.toLowerCase(),
        user = db
          .prepare("SELECT * FROM team_demo_users WHERE username=?")
          .get(username) as User | undefined;
      // Unknown accounts incur the same expensive password check.
      const key = await demoPasswordHash(
        req.body.password,
        user?.password_salt ?? "unregistered-demo-account",
      );
      const valid = timingSafeEqual(
        key,
        user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(64),
      );
      key.fill(0);
      if (!user || !valid || !user.enabled || user.locked_until > Date.now()) {
        if (user && user.locked_until <= Date.now()) {
          db.prepare(
            "UPDATE team_demo_users SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins>=4 THEN ? ELSE 0 END WHERE id=?",
          ).run(Date.now() + 60000, user.id);
        }
        return fail(
          reply,
          401,
          "Sign-in failed. Check your credentials or wait one minute after repeated attempts.",
        );
      }
      // Re-read after the asynchronous KDF: suspension or login throttling may
      // have changed while another request was hashing its password.
      const current = find(user.id);
      if (!current?.enabled || current.locked_until > Date.now())
        return fail(reply, 401, "Sign-in failed.");
      const token = randomBytes(32).toString("base64url"),
        expiresAt = Math.min(session.expires_at, Date.now() + 30 * 60 * 1000);
      db.transaction(() => {
        db.prepare(
          "UPDATE team_demo_users SET failed_logins=0,locked_until=0 WHERE id=?",
        ).run(user.id);
        db.prepare(
          "DELETE FROM team_demo_sessions WHERE public_session_id=? OR expires_at<=?",
        ).run(session.id, Date.now());
        db.prepare("INSERT INTO team_demo_sessions VALUES (?,?,?,?)").run(
          hash(token),
          user.id,
          session.id,
          expiresAt,
        );
        audit(user.id, "login");
      })();
      reply.setCookie(cookieName, token, {
        httpOnly: true,
        sameSite: "strict",
        path: cookiePath,
        secure: req.protocol === "https",
        maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
      });
      return { data: { user: publicUser(user) } };
    },
  );
  app.post(
    prefix + "/logout",
    { schema: { body: { type: "object", additionalProperties: false } } },
    async (req, reply) => {
      const token = req.cookies[cookieName];
      if (token)
        db.prepare("DELETE FROM team_demo_sessions WHERE token_hash=?").run(
          hash(token),
        );
      reply.clearCookie(cookieName, { path: cookiePath });
      reply.header("Cache-Control", "no-store");
      return { data: { signedOut: true } };
    },
  );
  const transfers = (user: User) =>
    db
      .prepare(
        `SELECT t.id,s.display_name AS sender,r.display_name AS recipient,t.amount_cents,t.created_at AS createdAt
    FROM team_demo_transfers t JOIN team_demo_users s ON s.id=t.sender_id JOIN team_demo_users r ON r.id=t.recipient_id
    ${user.role === "member" ? "WHERE t.sender_id=@id OR t.recipient_id=@id" : "WHERE @id IS NOT NULL"}
    ORDER BY t.rowid DESC LIMIT 50`,
      )
      .all({ id: user.id })
      .map((r) => {
        const row = r as {
          id: string;
          sender: string;
          recipient: string;
          amount_cents: number;
          createdAt: string;
        };
        return {
          id: row.id,
          sender: displayAccountName(row.sender),
          recipient: displayAccountName(row.recipient),
          amount: money(row.amount_cents),
          createdAt: row.createdAt,
        };
      });
  app.get(prefix + "/dashboard", async (req, reply) => {
    const user = authenticate(req, reply);
    if (!user) return;
    return {
      data: {
        user: publicUser(user),
        balance: money(user.balance_cents),
        canTransfer: user.role !== "auditor",
        recipients: (
          db
            .prepare(
              "SELECT * FROM team_demo_users WHERE enabled=1 AND role!='auditor' AND id!=? ORDER BY username",
            )
            .all(user.id) as User[]
        ).map(publicUser),
        transfers: transfers(user),
      },
    };
  });
  app.post<{
    Body: { recipientId: string; amount: string; requestId: string };
  }>(
    prefix + "/transfers",
    {
      schema: {
        body: {
          type: "object",
          required: ["recipientId", "amount", "requestId"],
          additionalProperties: false,
          properties: {
            recipientId: { type: "string", format: "uuid" },
            requestId: { type: "string", format: "uuid" },
            amount: {
              type: "string",
              pattern: "^(?:0|[1-9][0-9]{0,5})(?:\\.[0-9]{1,2})?$",
              maxLength: 9,
            },
          },
        },
      },
    },
    async (req, reply) => {
      const user = authenticate(req, reply, ["admin", "member"]);
      if (!user) return;
      const [whole, fraction = ""] = req.body.amount.split("."),
        cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
      if (!Number.isSafeInteger(cents) || cents <= 0)
        return fail(
          reply,
          400,
          "Enter a positive amount with at most two decimal places.",
        );
      const result = db.transaction(() => {
        const existing = db
          .prepare(
            "SELECT * FROM team_demo_transfers WHERE sender_id=? AND request_id=?",
          )
          .get(user.id, req.body.requestId) as
          | { id: string; recipient_id: string; amount_cents: number }
          | undefined;
        if (existing)
          return existing.recipient_id === req.body.recipientId &&
            existing.amount_cents === cents
            ? { id: existing.id, replayed: true }
            : {
                error:
                  "This request ID was already used for a different transfer.",
                status: 409,
              };
        const recipient = find(req.body.recipientId);
        if (
          !recipient?.enabled ||
          recipient.role === "auditor" ||
          recipient.id === user.id
        )
          return {
            error: "Choose another active transfer account.",
            status: 400,
          };
        if (recipient.balance_cents + cents > 100000000)
          return {
            error: "The recipient would exceed the balance limit.",
            status: 400,
          };
        const debit = db
          .prepare(
            "UPDATE team_demo_users SET balance_cents=balance_cents-? WHERE id=? AND enabled=1 AND role IN ('admin','member') AND balance_cents>=?",
          )
          .run(cents, user.id, cents);
        if (debit.changes !== 1)
          return { error: "Insufficient credits.", status: 409 };
        db.prepare(
          "UPDATE team_demo_users SET balance_cents=balance_cents+? WHERE id=?",
        ).run(cents, recipient.id);
        const id = randomUUID();
        db.prepare("INSERT INTO team_demo_transfers VALUES (?,?,?,?,?,?)").run(
          id,
          req.body.requestId,
          user.id,
          recipient.id,
          cents,
          new Date().toISOString(),
        );
        audit(user.id, "transfer", id);
        return { id, replayed: false };
      })();
      if ("error" in result) return fail(reply, result.status!, result.error!);
      return reply.code(result.replayed ? 200 : 201).send({ data: result });
    },
  );
  app.get(prefix + "/admin", async (req, reply) => {
    const user = authenticate(req, reply, ["admin", "auditor"]);
    if (!user) return;
    return {
      data: {
        users: (
          db
            .prepare("SELECT * FROM team_demo_users ORDER BY username")
            .all() as User[]
        ).map((u) => ({
          ...publicUser(u),
          balance: money(u.balance_cents),
          enabled: Boolean(u.enabled),
        })),
        events: db
          .prepare(
            `SELECT a.id,u.display_name AS actor,a.action,a.subject_id AS subject,a.created_at AS createdAt
        FROM team_demo_audit a LEFT JOIN team_demo_users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100`,
          )
          .all().map((value) => {
            const event = value as Record<string, unknown>;
            return { ...event, actor: typeof event.actor === "string" ? displayAccountName(event.actor) : null };
          }),
      },
    };
  });
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    prefix + "/users/:id/status",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
        },
      },
    },
    async (req, reply) => {
      const user = authenticate(req, reply, ["admin"]);
      if (!user) return;
      const target = find(req.params.id);
      if (!target || target.role !== "member")
        return fail(
          reply,
          400,
          "Only Member accounts can be suspended.",
        );
      db.transaction(() => {
        db.prepare("UPDATE team_demo_users SET enabled=? WHERE id=?").run(
          Number(req.body.enabled),
          target.id,
        );
        if (!req.body.enabled)
          db.prepare("DELETE FROM team_demo_sessions WHERE user_id=?").run(
            target.id,
          );
        audit(
          user.id,
          req.body.enabled ? "account_enabled" : "account_suspended",
          target.id,
        );
      })();
      return { data: { id: target.id, enabled: req.body.enabled } };
    },
  );
}
