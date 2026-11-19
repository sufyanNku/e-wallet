import "./report-paths.ts";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildServer } from "../services/backend/src/server";
import { networkRpc } from "../services/backend/src/node-rpc";
const persistent = process.argv.includes("--persistent");
const manifest = JSON.parse(
    await readFile(".local/state/seed/evm-manifest.json", "utf8"),
  ),
  alice = manifest.identities.alice.evm.address,
  deployment = manifest.deployments.find(
    (d: { chainId: string }) => d.chainId === "31337",
  ),
  app = await buildServer({
    databasePath: persistent ? ".local/local/backend.sqlite" : ":memory:",
  }),
  headers: Record<string, string> = {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };
try {
  const established = await app.inject({
    method: "POST",
    url: "/api/v1/session",
    headers,
    payload: {},
  });
  if (established.statusCode !== 200) throw new Error("Session fixture failed");
  headers.cookie = String(established.headers["set-cookie"]).split(";")[0];
  headers["x-csrf-token"] = established.json().data.csrfToken;
  const registration = await app.inject({
    method: "POST",
    url: "/api/v1/watch",
    headers,
    payload: { networkId: "eip155:31337", address: alice },
  });
  if (registration.statusCode !== 200)
    throw new Error("Public watch registration failed");
  const watchId = registration.json().data.watchId;
  let activity;
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await app.inject({
      url: "/api/v1/activity?watchId=" + watchId,
      headers,
    });
    activity = response.json().data;
    if (activity?.status === "ready") break;
    if (activity?.status === "unavailable")
      throw new Error("Real API index unavailable");
    if (attempt === 39) throw new Error("Bounded real API backfill timed out");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const balances = await app.inject({
      url: "/api/v1/balances?watchId=" + watchId,
      headers,
    }),
    native = balances
      .json()
      .data.balances.find((b: { standard: string }) => b.standard === "native"),
    actual = BigInt(
      String(
        await networkRpc("eip155:31337", "eth_getBalance", [alice, "latest"]),
      ),
    );
  if (BigInt(native.raw) !== actual || native.stale)
    throw new Error("API balance does not match current node");
  const contracts = await app.inject({
    url: "/api/v1/contracts/eip155:31337/state?watchId=" + watchId,
    headers,
  });
  if (
    contracts.statusCode !== 200 ||
    contracts.json().data.state.accountAddress.toLowerCase() !==
      alice.toLowerCase()
  )
    throw new Error("Real API contract state unavailable");
  const collectibles = await app.inject({
    url: "/api/v1/collectibles?watchId=" + watchId,
    headers,
  });
  if (
    collectibles.statusCode !== 200 ||
    collectibles.json().data.records.length === 0
  )
    throw new Error("Real API collectibles missing");
  const key =
      "eip155:31337/erc721/" +
      deployment.contracts.DemoNFT721.address.toLowerCase() +
      "/101",
    metadata = await app.inject({
      method: "POST",
      url: "/api/v1/metadata/request",
      headers,
      payload: { assetKey: key, allowRemote: false },
    });
  if (
    metadata.statusCode !== 200 ||
    metadata.json().data.status !== "safe" ||
    !metadata.json().data.image
  )
    throw new Error("Real NFT metadata did not produce safe cached media");
  const image = await app.inject({ url: metadata.json().data.image, headers });
  if (
    image.headers["content-type"] !== "image/webp" ||
    createHash("sha256").update(image.rawPayload).digest("hex") !==
      metadata.json().data.image.split("/").at(-1)
  )
    throw new Error("Safe image hash or type differs");
  const first = await app.inject({
      url: "/api/v1/notifications?watchId=" + watchId,
      headers,
    }),
    second = await app.inject({
      url: "/api/v1/notifications?watchId=" + watchId,
      headers,
    });
  if (
    !first.json().data.notifications.length ||
    second.json().data.notifications.length
  )
    throw new Error("Notifications were absent or repeated");
  await writeFile(
    ".local/reports/integration/public-api-proof.json",
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        source: "real-local-node-through-HTTP-handlers",
        sessionScoped: true,
        watchRegistered: true,
        historyRecords: activity.records.length,
        balancesMatchNode: true,
        contractsReconciled: true,
        collectibles: collectibles.json().data.records.length,
        metadataFromActualTokenUri: true,
        safeImageHashVerified: true,
        notificationsDeduplicated: true,
        backendDatabase: persistent ? "persistent-local-sqlite" : ":memory:",
      },
      null,
      2,
    ),
  );
  console.log(
    "Real session-scoped API, contract reconciliation, safe NFT media and notification deduplication passed.",
  );
} finally {
  await app.close();
}
