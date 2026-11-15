import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Interface } from "ethers";
import { z } from "zod";
import {
  assetIdSchema,
  assetKey,
  solanaManifestSchema,
  type AssetId,
} from "@ewallet/domain";
import { networkById } from "@ewallet/config";
import { abis } from "@ewallet/config/abis";
import { SolanaAdapter } from "@ewallet/chain-solana";
import { networkRpc } from "./node-rpc";
import { safeDownload } from "./safe-fetch";
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const text = z.string().max(3000),
  schema = z.object({
    name: z.string().max(100).optional(),
    description: text.optional(),
    image: z.string().max(2048).optional(),
    attributes: z
      .array(
        z.object({
          trait_type: z.string().max(100),
          value: z.union([
            z.string().max(200),
            z.number().finite(),
            z.boolean(),
          ]),
        }),
      )
      .max(50)
      .optional(),
  });
const fixtures = new Map([
  ["/fixtures/campus.json", "fixtures/media/campus.json"],
  ["/fixtures/study.json", "fixtures/media/study.json"],
  ["/fixtures/broken.json", "fixtures/media/broken.json"],
  ["/fixtures/malformed.json", "fixtures/media/malformed.json"],
  ["/fixtures/campus.png", "fixtures/media/campus.png"],
]);
export function parseAssetKey(value: string): AssetId {
  const [networkId, standard, reference, tokenId, ...rest] = value.split("/");
  if (rest.length || value.length > 600) throw new Error("Invalid asset key");
  networkById(networkId);
  return assetIdSchema.parse({
    networkId,
    standard,
    reference,
    ...(tokenId ? { tokenId } : {}),
  });
}
function localFixture(uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "8787" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  const path = /^\/fixtures\/[0-9a-f]{64}\.json$/.test(url.pathname)
    ? "fixtures/media/study.json"
    : fixtures.get(url.pathname);
  return path ?? null;
}
export async function fetchMetadataBytes(
  uri: string,
  allowRemote: boolean,
  limit: number,
) {
  const local = localFixture(uri);
  if (local) {
    const bytes = await readFile(local);
    if (bytes.length > limit) throw new Error("Fixture exceeds limit");
    return {
      bytes,
      contentType: local.endsWith(".json") ? "application/json" : "image/png",
      url: uri,
      source: "local-fixture",
    };
  }
  if (!allowRemote) throw new Error("Remote media is blocked by preference");
  const result = await safeDownload(uri, limit);
  return { ...result, source: "remote-https" };
}
export async function reencodeRaster(bytes: Buffer) {
  const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    webp =
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP",
    avif =
      bytes.subarray(4, 8).toString() === "ftyp" &&
      /avif|avis/.test(bytes.subarray(8, 32).toString());
  if (!png && !jpeg && !webp && !avif)
    throw new Error("Only sniffed PNG/JPEG/WebP/AVIF rasters are supported");
  const input = sharp(bytes, {
      limitInputPixels: 4096 * 4096,
      failOn: "warning",
      animated: false,
    }),
    info = await input.metadata();
  if (
    !info.width ||
    !info.height ||
    info.width > 4096 ||
    info.height > 4096 ||
    (info.pages ?? 1) > 1
  )
    throw new Error("Image dimensions or animation exceeds policy");
  const output = await input
    .rotate()
    .resize({
      width: 1024,
      height: 1024,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 90, effort: 4 })
    .toBuffer();
  if (output.length > 5 * 1024 * 1024)
    throw new Error("Re-encoded image exceeds limit");
  return output;
}
async function metadataUri(asset: AssetId) {
  const profile = networkById(asset.networkId);
  if (profile.family === "evm") {
    const chain = BigInt(
      String(await networkRpc(asset.networkId, "eth_chainId")),
    ).toString();
    if (chain !== profile.identity) throw new Error("Wrong metadata network");
    if (
      !["erc721", "erc1155"].includes(asset.standard) ||
      asset.tokenId === undefined
    )
      throw new Error("Unsupported metadata standard");
    const iface = new Interface(
        asset.standard === "erc721" ? abis.DemoNFT721 : abis.DemoNFT1155,
      ),
      method = asset.standard === "erc721" ? "tokenURI" : "uri",
      data = iface.encodeFunctionData(method, [BigInt(asset.tokenId)]),
      result = await networkRpc(asset.networkId, "eth_call", [
        { to: asset.reference, data },
        "latest",
      ]);
    const uri = z
      .string()
      .max(2048)
      .parse(iface.decodeFunctionResult(method, String(result))[0]);
    return uri.replaceAll(
      "{id}",
      BigInt(asset.tokenId).toString(16).padStart(64, "0"),
    );
  }
  if (profile.family === "solana") {
    let local: ConstructorParameters<typeof SolanaAdapter>[2];
    if (profile.environment === "local") {
      const manifest = solanaManifestSchema.parse(
        JSON.parse(
          await readFile(
            process.env.EWALLET_ISOLATED_SOLANA_TEST === "1"
              ? "artifacts/phase-03/isolated-solana-manifest.json"
              : "artifacts/seed/solana-manifest.json",
            "utf8",
          ),
        ),
      );
      local = {
        genesisHash: manifest.genesisHash,
        mints: Object.values(manifest.mints),
      };
    }
    const adapter = new SolanaAdapter(
      asset.networkId,
      (method, params) => networkRpc(asset.networkId, method, params),
      local,
    );
    await adapter.identity();
    const metadata = await adapter.metadata(asset.reference);
    if (!metadata) throw new Error("Metaplex metadata unavailable");
    return metadata.uri.replace(/\0/g, "").trim();
  }
  throw new Error("This chain has no supported NFT metadata.");
}
async function loadSafeMetadataInternal(
  db: Database.Database,
  asset: AssetId,
  allowRemote = false,
) {
  const key = assetKey(asset),
    cached = db
      .prepare(
        "SELECT status,metadata_json,expires_at FROM metadata_cache WHERE asset_key=?",
      )
      .get(key) as
      | {
          status: string;
          metadata_json: string | null;
          expires_at: string | null;
        }
      | undefined;
  if (
    cached?.status === "safe" &&
    cached.metadata_json &&
    Date.parse(cached.expires_at ?? "") > Date.now()
  )
    return JSON.parse(cached.metadata_json) as Record<string, unknown>;
  let uri: string | null = null;
  try {
    uri = await metadataUri(asset);
    const response = await fetchMetadataBytes(uri, allowRemote, 256 * 1024);
    if (response.contentType !== "application/json")
      throw new Error("Metadata must be JSON");
    const metadata = schema.parse(JSON.parse(response.bytes.toString("utf8")));
    let image: string | null = null,
      imageStatus = "missing";
    if (metadata.image)
      try {
        const imageUri = new URL(metadata.image, response.url).toString(),
          download = await fetchMetadataBytes(
            imageUri,
            allowRemote,
            5 * 1024 * 1024,
          ),
          raster = await reencodeRaster(download.bytes),
          hash = digest(raster);
        await mkdir(".local/media-cache", { recursive: true });
        await writeFile(".local/media-cache/" + hash + ".webp", raster);
        image = "/api/v1/media/" + hash;
        imageStatus = "safe";
      } catch {
        imageStatus = "blocked";
      }
    const result = {
      assetKey: key,
      name: metadata.name ?? null,
      description: metadata.description ?? null,
      attributes: metadata.attributes ?? [],
      image,
      imageStatus,
      status: imageStatus === "safe" ? "safe" : "missing",
      source: response.source,
      observedAt: new Date().toISOString(),
    };
    db.prepare(
      "INSERT INTO metadata_cache(asset_key,status,url_hash,content_hash,metadata_json,expires_at,source) VALUES (?,?,?,?,?,?,?) ON CONFLICT(asset_key) DO UPDATE SET status=excluded.status,url_hash=excluded.url_hash,content_hash=excluded.content_hash,metadata_json=excluded.metadata_json,expires_at=excluded.expires_at,source=excluded.source",
    ).run(
      key,
      result.status,
      digest(uri),
      image?.split("/").at(-1) ?? null,
      JSON.stringify(result),
      new Date(Date.now() + 86400000).toISOString(),
      response.source,
    );
    return result;
  } catch {
    const result = {
      assetKey: key,
      name: null,
      description: null,
      attributes: [],
      image: null,
      imageStatus: "blocked",
      status: "blocked",
      source: "unavailable",
      observedAt: null,
    };
    db.prepare(
      "INSERT INTO metadata_cache(asset_key,status,url_hash,metadata_json,expires_at,source) VALUES (?,?,?,?,?,?) ON CONFLICT(asset_key) DO UPDATE SET status=excluded.status,metadata_json=excluded.metadata_json,expires_at=excluded.expires_at",
    ).run(
      key,
      "blocked",
      uri ? digest(uri) : null,
      JSON.stringify(result),
      new Date(Date.now() + 60000).toISOString(),
      "unavailable",
    );
    return result;
  }
}
const metadataJobs=new WeakMap<Database.Database,Map<string,ReturnType<typeof loadSafeMetadataInternal>>>();
let activeMediaJobs=0;
const mediaQueue:Array<()=>void>=[];
export function loadSafeMetadata(db:Database.Database,asset:AssetId,allowRemote=false){let jobs=metadataJobs.get(db);if(!jobs){jobs=new Map();metadataJobs.set(db,jobs);}const key=assetKey(asset)+':'+allowRemote,existing=jobs.get(key);if(existing)return existing;const job=(async()=>{if(activeMediaJobs>=3){if(mediaQueue.length>=32)throw new Error('Metadata queue is full');await new Promise<void>(resolve=>mediaQueue.push(resolve));}else activeMediaJobs++;try{return await loadSafeMetadataInternal(db,asset,allowRemote);}finally{const next=mediaQueue.shift();if(next)next();else activeMediaJobs--;}})();jobs.set(key,job);void job.finally(()=>{jobs!.delete(key);}).catch(()=>{});return job;}
export async function registerMetadata(
  app: FastifyInstance,
  db: Database.Database,
) {
  app.get("/fixtures/:name", async (req, reply) => {
    const name = z
        .string()
        .max(100)
        .parse((req.params as { name: string }).name),
      uri = "http://127.0.0.1:8787/fixtures/" + name,
      path = localFixture(uri);
    if (!path)
      return reply
        .code(404)
        .send({
          error: {
            code: "FIXTURE_MISSING",
            message: "This fixture does not exist.",
            correlationId: req.id,
          },
        });
    reply.type(path.endsWith(".json") ? "application/json" : "image/png");
    return reply.send(await readFile(path));
  });
  app.post("/api/v1/metadata/request", async (req, reply) => {
    try {
      const body = z
        .object({
          assetKey: z.string().max(600),
          allowRemote: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
      return {
        data: await loadSafeMetadata(
          db,
          parseAssetKey(body.assetKey),
          body.allowRemote,
        ),
        meta: { source: "metadata-cache" },
      };
    } catch {
      return reply
        .code(400)
        .send({
          error: {
            code: "METADATA_SCHEMA",
            message: "Invalid metadata request.",
            correlationId: req.id,
          },
        });
    }
  });
  app.get("/api/v1/metadata/:assetKey", async (req, reply) => {
    try {
      const asset = parseAssetKey(
        (req.params as { assetKey: string }).assetKey,
      );
      return {
        data: await loadSafeMetadata(db, asset, false),
        meta: { source: "metadata-cache" },
      };
    } catch {
      return reply
        .code(400)
        .send({
          error: {
            code: "METADATA_SCHEMA",
            message: "Invalid metadata identifier.",
            correlationId: req.id,
          },
        });
    }
  });
  app.get("/api/v1/media/:hash", async (req, reply) => {
    try {
      const hash = z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .parse((req.params as { hash: string }).hash),
        image = await readFile(".local/media-cache/" + hash + ".webp");
      if (digest(image) !== hash) throw new Error("Cached media hash differs");
      reply
        .header("Cache-Control", "public,max-age=31536000,immutable")
        .type("image/webp");
      return reply.send(image);
    } catch {
      return reply
        .code(404)
        .send({
          error: {
            code: "MEDIA_MISSING",
            message: "Cached safe media is unavailable.",
            correlationId: req.id,
          },
        });
    }
  });
}
