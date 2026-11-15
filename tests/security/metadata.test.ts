import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import {
  canonicalMetadataUrl,
  isPublicAddress,
  validateRemoteTarget,
} from "../../services/backend/src/safe-fetch";
import {
  fetchMetadataBytes,
  reencodeRaster,
} from "../../services/backend/src/metadata";
it("rejects credentials, local/private/mapped addresses, disallowed schemes and unsafe redirects before a connection", async () => {
  for (const value of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "0.0.0.0",
  ])
    expect(isPublicAddress(value)).toBe(false);
  for (const url of [
    "http://example.com/a",
    "file:///etc/passwd",
    "https://user:pass@example.com/a",
    "https://example.com:8443/a",
    "data:text/html,hello",
  ])
    expect(() => canonicalMetadataUrl(url)).toThrow();
  for (const url of [
    "https://127.0.0.1/a",
    "https://2130706433/a",
    "https://0x7f000001/a",
    "https://[::ffff:127.0.0.1]/a",
  ])
    await expect(validateRemoteTarget(url)).rejects.toThrow("public");
  const resolver = async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await expect(
    validateRemoteTarget(
      "https://example.com/redirect",
      resolver as unknown as typeof import("node:dns/promises").lookup,
    ),
  ).rejects.toThrow("public");
  expect(
    canonicalMetadataUrl("ipfs://" + "bafy" + "a".repeat(55) + "/campus.json")
      .hostname,
  ).toBe("ipfs.io");
});
it("uses an explicit local fixture map and never makes arbitrary private-host exceptions", async () => {
  const response = await fetchMetadataBytes(
    "http://127.0.0.1:8787/fixtures/campus.json",
    false,
    256 * 1024,
  );
  expect(JSON.parse(response.bytes.toString()).name).toContain("Campus");
  await expect(
    fetchMetadataBytes("http://127.0.0.1:8787/not-a-fixture", false, 1024),
  ).rejects.toThrow("blocked");
  await expect(
    fetchMetadataBytes(
      "http://127.0.0.1:8787/fixtures/campus.json?redirect=1",
      false,
      1024,
    ),
  ).rejects.toThrow("blocked");
});
it("re-encodes the original fixture as metadata-free WebP and refuses SVG/HTML and excessive dimensions", async () => {
  const output = await reencodeRaster(
      await readFile("fixtures/media/campus.png"),
    ),
    metadata = await sharp(output).metadata();
  expect(metadata.format).toBe("webp");
  expect(metadata.exif).toBeUndefined();
  expect(metadata.width).toBeLessThanOrEqual(1024);
  await expect(
    reencodeRaster(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    ),
  ).rejects.toThrow("sniffed");
  await expect(
    reencodeRaster(Buffer.from("<html>active</html>")),
  ).rejects.toThrow("sniffed");
  const oversized = await sharp({
    create: { width: 4097, height: 1, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await expect(reencodeRaster(oversized)).rejects.toThrow("dimensions");
});
