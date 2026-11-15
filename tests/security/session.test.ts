import { it, expect } from "vitest";
import { buildServer } from "../../services/backend/src/server";
it("binds anonymous public-data sessions to exact origin, JSON, fetch metadata and CSRF", async () => {
  const app = await buildServer({ databasePath: ":memory:" });
  const headers = {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };
  try {
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: { ...headers, origin: "https://attacker.example" },
      payload: {},
    });
    expect(wrong.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/session",
          headers: { ...headers, "sec-fetch-site": "cross-site" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/session",
          headers,
          payload: { mnemonic: "sensitive" },
        })
      ).statusCode,
    ).toBe(400);
    const valid = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers,
      payload: {},
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.headers["set-cookie"]).toContain("HttpOnly");
    expect(valid.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(valid.json().data.csrfToken).toHaveLength(43);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/rpc/eip155:31337",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    for (const path of [
      "/sign",
      "/mnemonic",
      "/private-key",
      "/admin/mine",
      "/admin/reset",
    ])
      expect(
        (
          await app.inject({
            url: "/api/v1" + path,
            headers: { host: headers.host },
          })
        ).statusCode,
      ).toBe(404);
  } finally {
    await app.close();
  }
});
