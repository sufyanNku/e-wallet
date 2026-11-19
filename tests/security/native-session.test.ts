import { it, expect } from "vitest";
import { buildServer } from "../../services/backend/src/server";
import { runtimeConfig } from "../../services/backend/src/runtime-config";
it("requires explicit HTTPS deployment origins and validates ports", () => {
  expect(() => runtimeConfig({ NODE_ENV: "production" })).toThrow();
  expect(() =>
    runtimeConfig({
      NODE_ENV: "production",
      EWALLET_PUBLIC_ORIGINS: "http://wallet.example",
    }),
  ).toThrow();
  expect(() =>
    runtimeConfig({ EWALLET_PUBLIC_ORIGINS: "https://wallet.example/path" }),
  ).toThrow();
  expect(() => runtimeConfig({ PORT: "NaN" })).toThrow();
  const c = runtimeConfig({
    NODE_ENV: "production",
    EWALLET_PUBLIC_ORIGINS: "https://wallet.example",
  });
  expect(c.origins).toEqual(["https://wallet.example"]);
  expect(c.hosts).toContain("wallet.example");
});
it("binds native bearer sessions to their client type, JSON, CSRF and absence of browser origins", async () => {
  const app = await buildServer({ databasePath: ":memory:" }),
    headers = {
      host: "127.0.0.1:8787",
      "content-type": "application/json",
      "x-wallet-client": "native-v1",
    };
  try {
    for (const extra of [
      { origin: "https://attacker.example" },
      { "sec-fetch-site": "same-origin" },
      { "x-wallet-client": "web" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/session/native",
            headers: { ...headers, ...extra },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/session/native",
          headers,
          payload: { mnemonic: "never accepted" },
        })
      ).statusCode,
    ).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session/native",
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    const auth = response.json().data;
    expect(auth.token).toHaveLength(43);
    expect(auth.csrfToken).toHaveLength(43);
    const request = {
      method: "POST" as const,
      url: "/api/v1/rpc/eip155:31337",
      headers: {
        ...headers,
        authorization: "Bearer " + auth.token,
        "x-csrf-token": auth.csrfToken,
      },
      payload: {},
    };
    expect((await app.inject(request)).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          ...request,
          headers: { ...request.headers, "x-csrf-token": "bad" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          ...request,
          headers: {
            ...request.headers,
            origin: "http://127.0.0.1:8787",
            "sec-fetch-site": "same-origin",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          ...request,
          headers: {
            ...headers,
            cookie: "ewallet_session=" + auth.token,
            origin: "http://127.0.0.1:8787",
            "sec-fetch-site": "same-origin",
            "x-csrf-token": auth.csrfToken,
          },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
