import { it, expect } from "vitest";
import { buildServer } from "../services/backend/src/server";
it("restricts host, serves nested routes, and sets signing-site security headers", async () => {
  const app = await buildServer({databasePath:":memory:"});
  try {
    const h = await app.inject({
      url: "/api/v1/health",
      headers: { host: "127.0.0.1:8787" },
    });
    expect(h.statusCode).toBe(200);
    expect(h.headers["content-security-policy"]).toContain("worker-src 'self'");
    expect(h.headers["content-security-policy"]).not.toContain("'unsafe-eval'");
    expect(h.headers["referrer-policy"]).toBe("no-referrer");
    expect(
      (await app.inject({ url: "/", headers: { host: "attacker.invalid" } }))
        .statusCode,
    ).toBe(403);
    const nested = await app.inject({
      url: "/send",
      headers: { host: "127.0.0.1:8787" },
    });
    expect(nested.statusCode).toBe(200);
    expect(nested.body).toContain('<div id="root">');
    const connect = await app.inject({
      url: "/connect",
      headers: { host: "127.0.0.1:8787" },
    });
    expect(connect.headers["cross-origin-opener-policy"]).toBe("unsafe-none");
    expect(
      (
        await app.inject({
          url: "/api/no-such-route",
          headers: { host: "127.0.0.1:8787" },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
