import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
export function canonicalMetadataUrl(input: string) {
  if (input.length > 2048) throw new Error("Metadata URL exceeds policy");
  if (input.startsWith("ipfs://")) {
    const value = input.slice(7),
      [cid, ...path] = value.split("/");
    if (
      !/^[a-zA-Z0-9]{46,100}$/.test(cid) ||
      path.some((p) => p === ".." || p === "." || p.includes("%"))
    )
      throw new Error("Unsupported IPFS path");
    input =
      "https://ipfs.io/ipfs/" +
      cid +
      (path.length ? "/" + path.map(encodeURIComponent).join("/") : "");
  }
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash
  )
    throw new Error("Only credential-free HTTPS metadata is supported");
  return url;
}
export function isPublicAddress(value: string) {
  try {
    return ipaddr.process(value).range() === "unicast";
  } catch {
    return false;
  }
}
export async function validateRemoteTarget(input: string, resolver = lookup) {
  const url = canonicalMetadataUrl(input),
    hostname = url.hostname.replace(/^\[|\]$/g, ""),
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error("Metadata destination is not a public address");
  return {
    url,
    address: addresses[0].address,
    family: addresses[0].family as 4 | 6,
  };
}
export async function safeDownload(
  input: string,
  limit: number,
  redirects = 0,
  deadline = Date.now() + 5000,
): Promise<{ bytes: Buffer; contentType: string; url: string }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Metadata deadline exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const target = await Promise.race([
    validateRemoteTarget(input),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Metadata DNS deadline exceeded")),
        remaining,
      );
      timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return new Promise((resolve, reject) => {
    // Pin the validated address in the connection itself; TLS still authenticates
    // the original hostname. DNS cannot be rebound between validation and use.
    const client = request(
      target.url,
      {
        method: "GET",
        agent: false,
        family: target.family,
        lookup: (_host, _options, callback) =>
          callback(null, target.address, target.family),
        headers: {
          Accept: "application/json,image/png,image/jpeg,image/webp,image/avif",
          "Accept-Encoding": "identity",
          "User-Agent": "e-wallet-local-metadata/1",
        },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location || redirects >= 2) {
            reject(new Error("Metadata redirect exceeds policy"));
            return;
          }
          void safeDownload(
            new URL(location, target.url).toString(),
            limit,
            redirects + 1,
            deadline,
          ).then(resolve, reject);
          return;
        }
        if (
          status !== 200 ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          response.destroy();
          reject(new Error("Metadata response is unsupported"));
          return;
        }
        const length = Number(response.headers["content-length"] ?? 0);
        if (!Number.isSafeInteger(length) || length > limit) {
          response.destroy();
          reject(new Error("Metadata response exceeds size limit"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            response.destroy(new Error("Metadata response exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            bytes: Buffer.concat(chunks),
            contentType: String(response.headers["content-type"] ?? "")
              .split(";")[0]
              .trim()
              .toLowerCase(),
            url: target.url.toString(),
          }),
        );
        response.on("error", reject);
      },
    );
    client.on("error", reject);
    client.end();
  });
}
