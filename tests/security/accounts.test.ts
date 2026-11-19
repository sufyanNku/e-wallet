import Fastify from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { registerSessions } from "../../services/backend/src/sessions";
import {
  accountPasswordHash,
  registerAccounts,
  accountsEnabled,
} from "../../services/backend/src/accounts";
const password = "Account test password";
const headers = {
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:8787",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};
async function setup(enabled = true) {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const { db, session } = await registerSessions(app, ":memory:");
  registerAccounts(app, db, session, enabled);
  const ids = {
    alice: randomUUID(),
    bob: randomUUID(),
    admin: randomUUID(),
    auditor: randomUUID(),
  };
  const salt = randomBytes(16).toString("hex"),
    digest = (await accountPasswordHash(password, salt)).toString("hex");
  for (const [username, id] of Object.entries(ids))
    db.prepare(
      "INSERT INTO account_users(id,username,display_name,role,password_salt,password_hash,balance_cents) VALUES (?,?,?,?,?,?,?)",
    ).run(
      id,
      username,
      username,
      username === "admin"
        ? "admin"
        : username === "auditor"
          ? "auditor"
          : "member",
      salt,
      digest,
      username === "alice" || username === "bob" ? 100000 : 0,
    );
  async function browser() {
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers,
      payload: {},
    });
    let cookies = start.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const csrf = start.json().data.csrfToken;
    const request = async (
      path: string,
      method: "GET" | "POST" = "GET",
      body?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const r = await app.inject({
        method,
        url: "/api/v1/accounts" + path,
        headers: {
          ...headers,
          cookie: cookies,
          "x-csrf-token": csrf,
          ...extra,
        },
        ...(method === "POST" ? { payload: body ?? {} } : {}),
      });
      for (const c of r.cookies) {
        cookies = cookies
          .split("; ")
          .filter((v) => !v.startsWith(c.name + "="))
          .concat(`${c.name}=${c.value}`)
          .join("; ");
      }
      return r;
    };
    return {
      request,
      login: (username: string, pw = password) =>
        request("/login", "POST", { username, password: pw }),
    };
  }
  return { app, db, ids, browser };
}
it("keeps account routes disabled in production/testnet and by default", async () => {
  expect(accountsEnabled({})).toBe(false);
  expect(accountsEnabled({ EWALLET_ACCOUNTS: "1" })).toBe(true);
  expect(
    accountsEnabled({ EWALLET_ACCOUNTS: "1", NODE_ENV: "production" }),
  ).toBe(false);
  expect(
    accountsEnabled({ EWALLET_ACCOUNTS: "1", EWALLET_MODE: "testnet" }),
  ).toBe(false);
  expect(accountsEnabled({ EWALLET_ACCOUNTS: "1", HOST: "0.0.0.0" })).toBe(
    false,
  );
  const { app, browser } = await setup(false);
  try {
    expect(
      (await app.inject("/api/v1/accounts/status")).json().data.enabled,
    ).toBe(false);
    const b = await browser();
    expect((await b.login("alice")).statusCode).toBe(404);
    expect((await b.request("/dashboard")).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
it("requires authentication, exact origin, CSRF and honest credentials; revokes logout and expiry", async () => {
  const { app, db, browser } = await setup();
  try {
    const b = await browser();
    expect((await b.request("/dashboard")).statusCode).toBe(401);
    expect((await b.login("alice", "wrong password")).statusCode).toBe(401);
    expect((await b.login("unknown", "wrong password")).statusCode).toBe(401);
    expect(
      (
        await b.request(
          "/login",
          "POST",
          { username: "alice", password },
          { "x-csrf-token": "bad" },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await b.request(
          "/login",
          "POST",
          { username: "alice", password },
          { origin: "https://attacker.example" },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await b.request("/login", "POST", {
          username: "alice",
          password,
          role: "admin",
        })
      ).statusCode,
    ).toBe(400);
    const login = await b.login("alice");
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(login.headers["cache-control"]).toBe("no-store");
    expect((await b.request("/dashboard")).json().data.user.role).toBe(
      "member",
    );
    await b.request("/logout", "POST");
    expect((await b.request("/dashboard")).statusCode).toBe(401);
    await b.login("alice");
    db.prepare("UPDATE account_sessions SET expires_at=0").run();
    expect((await b.request("/dashboard")).statusCode).toBe(401);
    expect(
      (
        db
          .prepare("SELECT password_hash FROM account_users LIMIT 1")
          .get() as { password_hash: string }
      ).password_hash,
    ).not.toBe(password);
  } finally {
    await app.close();
  }
});
it("blocks admin access and forged ownership, performs exact transfers and prevents replay", async () => {
  const { app, db, ids, browser } = await setup();
  try {
    const a = await browser(),
      b = await browser();
    await a.login("alice");
    await b.login("bob");
    expect((await a.request("/admin")).statusCode).toBe(403);
    expect(
      (await a.request(`/users/${ids.bob}/status`, "POST", { enabled: false }))
        .statusCode,
    ).toBe(403);
    const payload = {
      recipientId: ids.bob,
      amount: "25.15",
      requestId: randomUUID(),
    };
    expect(
      (
        await a.request("/transfers", "POST", {
          ...payload,
          senderId: ids.admin,
        })
      ).statusCode,
    ).toBe(400);
    const first = await a.request("/transfers", "POST", payload);
    expect(first.statusCode).toBe(201);
    const replay = await a.request("/transfers", "POST", payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(
      (await a.request("/transfers", "POST", { ...payload, amount: "25.16" }))
        .statusCode,
    ).toBe(409);
    expect((await a.request("/dashboard")).json().data.balance).toBe("974.85");
    expect((await b.request("/dashboard")).json().data.balance).toBe("1025.15");
    expect(
      db
        .prepare("SELECT SUM(balance_cents) AS total FROM account_users")
        .get(),
    ).toEqual({ total: 200000 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM account_transfers").get(),
    ).toEqual({ count: 1 });
    // Members cannot see transfers between other people.
    const ad = await browser();
    await ad.login("admin");
    await b.request("/transfers", "POST", {
      recipientId: ids.admin,
      amount: "1",
      requestId: randomUUID(),
    });
    expect((await a.request("/dashboard")).json().data.transfers).toHaveLength(
      1,
    );
    expect((await ad.request("/dashboard")).json().data.transfers).toHaveLength(
      2,
    );
  } finally {
    await app.close();
  }
});
it("rejects invalid amounts and recipients and cannot overdraw on concurrent requests", async () => {
  const { app, db, ids, browser } = await setup();
  try {
    const a = await browser();
    await a.login("alice");
    for (const amount of ["0", "-1", "0.001", "1e2", "NaN", "1000000", "01.00"])
      expect(
        (
          await a.request("/transfers", "POST", {
            recipientId: ids.bob,
            amount,
            requestId: randomUUID(),
          })
        ).statusCode,
      ).toBe(400);
    for (const recipientId of [ids.alice, ids.auditor, randomUUID()])
      expect(
        (
          await a.request("/transfers", "POST", {
            recipientId,
            amount: "1",
            requestId: randomUUID(),
          })
        ).statusCode,
      ).toBe(400);
    const results = await Promise.all(
      [1, 2].map(() =>
        a.request("/transfers", "POST", {
          recipientId: ids.bob,
          amount: "750",
          requestId: randomUUID(),
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await a.request("/dashboard")).json().data.balance).toBe("250.00");
    expect(
      db
        .prepare("SELECT SUM(balance_cents) AS total FROM account_users")
        .get(),
    ).toEqual({ total: 200000 });
  } finally {
    await app.close();
  }
});
it("enforces Auditor read-only access and immediately revokes suspended Members", async () => {
  const { app, ids, browser } = await setup();
  try {
    const a = await browser(),
      ad = await browser(),
      view = await browser();
    await a.login("alice");
    await ad.login("admin");
    await view.login("auditor");
    expect((await view.request("/admin")).statusCode).toBe(200);
    expect(
      (
        await view.request("/transfers", "POST", {
          recipientId: ids.bob,
          amount: "1",
          requestId: randomUUID(),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await view.request(`/users/${ids.alice}/status`, "POST", {
          enabled: false,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ad.request(`/users/${ids.admin}/status`, "POST", {
          enabled: false,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await ad.request(`/users/${ids.alice}/status`, "POST", {
          enabled: false,
        })
      ).statusCode,
    ).toBe(200);
    expect((await a.request("/dashboard")).statusCode).toBe(401);
    expect((await a.login("alice")).statusCode).toBe(401);
    expect(
      (
        await ad.request(`/users/${ids.alice}/status`, "POST", {
          enabled: true,
        })
      ).statusCode,
    ).toBe(200);
    expect((await a.login("alice")).statusCode).toBe(200);
    const events = (await ad.request("/admin")).json().data.events;
    expect(
      events.some((e: { action: string }) => e.action === "account_suspended"),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain(password);
  } finally {
    await app.close();
  }
});
it("throttles repeated bad passwords even across public sessions", async () => {
  const { app, db, ids, browser } = await setup();
  try {
    const b = await browser();
    for (let i = 0; i < 5; i++)
      expect((await b.login("alice", "wrong")).statusCode).toBe(401);
    const other = await browser();
    expect((await other.login("alice")).statusCode).toBe(401);
    db.prepare("UPDATE account_users SET locked_until=0 WHERE id=?").run(
      ids.alice,
    );
    expect((await other.login("alice")).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
