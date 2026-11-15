import { readdir, readFile } from "node:fs/promises";
const violations = [];
async function scan(path) {
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(e.name)) continue;
    const p = path + "/" + e.name;
    if (e.isDirectory()) await scan(p);
    else if (/\.[cm]?[jt]sx?$/.test(p)) {
      const s = await readFile(p, "utf8");
      if (
        /(?:from\s*|import\s*\()['"][^'"]*(?:wallet-core|scure\/bip|micro-key-producer|ecpair)[^'"]*['"]/.test(
          s,
        ) &&
        !p.endsWith("/signing.worker.ts")
      )
        violations.push(p);
    }
  }
}
await scan("apps");
await scan("services");
if (violations.length) {
  console.error("Secret-code import boundary violated:", violations);
  process.exitCode = 1;
} else
  console.log(
    "Import boundaries passed: UI/dapp/backend have no secret-code imports.",
  );
