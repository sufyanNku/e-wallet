export class NativeApi {
  private auth: { token: string; csrfToken: string; expiresAt: string } | null =
    null;
  constructor(
    readonly baseUrl: string,
    private transport: typeof fetch = (input, init) => fetch(input, init),
  ) {
    const u = new URL(baseUrl);
    if (
      u.protocol !== "https:" &&
      !(
        ["127.0.0.1", "localhost", "10.0.2.2"].includes(u.hostname) &&
        u.protocol === "http:"
      )
    )
      throw new Error("Use HTTPS for the wallet API.");
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
      throw new Error("API must be an origin without credentials or a path.");
    this.baseUrl = u.origin;
  }
  fetch(path: string, init?: RequestInit) {
    if (!path.startsWith("/api/v1/"))
      throw new Error("Unsupported public route.");
    return this.transport(this.baseUrl + path, init);
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (!/^\/api\/v1\//.test(path)) throw new Error("Unsupported API route.");
    if (!this.auth || Date.parse(this.auth.expiresAt) < Date.now() + 5000) {
      const r = await this.transport(this.baseUrl + "/api/v1/session/native", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Wallet-Client": "native-v1",
        },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok)
        throw new Error(
          "The wallet service is unavailable. Check your connection.",
        );
      this.auth = (await r.json()).data;
    }
    const auth = this.auth!;
    const r = await this.transport(this.baseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + auth.token,
        "X-CSRF-Token": auth.csrfToken,
        "X-Wallet-Client": "native-v1",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 403 || r.status === 401) {
      this.auth = null;
      throw new Error("Connection expired. Refresh and review again.");
    }
    if (!r.ok)
      throw new Error(
        "The network could not complete this request. Please try again.",
      );
    return (await r.json()).data as T;
  }
  rpc<T>(network: string, method: string, params: unknown[] = []): Promise<T> {
    return this.request<{ result?: T; error?: { message: string } }>(
      "/api/v1/rpc/" + encodeURIComponent(network),
      "POST",
      { jsonrpc: "2.0", id: 1, method, params },
    ).then((r) => {
      if (r.error) throw new Error("Network rejected the request.");
      return r.result as T;
    });
  }
  clear() {
    this.auth = null;
  }
}
