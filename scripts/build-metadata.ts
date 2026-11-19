import "./report-paths.ts";
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  chmod,
  access,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const exec = promisify(execFile),
  build = JSON.parse(await readFile("infra/metaplex-build.json", "utf8")) as {
    repository: string;
    commit: string;
    programSha256: string;
    lockfileSha256: string;
    platformToolsUrl: string;
    platformToolsSha256: string;
    rustupInitSha256: string;
    rustcSha256: string;
  };
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function run(command: string, args: string[], env = process.env) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(command + " failed (" + code + ")")),
    );
  });
}
async function download(url: string, path: string, expected: string) {
  if (!(await exists(path)))
    await run("curl", [
      "--fail",
      "--location",
      "--retry",
      "2",
      "--output",
      path,
      url,
    ]);
  if ((await hash(path)) !== expected)
    throw new Error("Build dependency checksum mismatch: " + path);
}
await mkdir(".local/programs", { recursive: true });
const target = ".local/programs/token_metadata.so";
if(!process.argv.includes('--rebuild')&&await exists('artifacts/programs/token_metadata.so')&&await hash('artifacts/programs/token_metadata.so')===build.programSha256)await copyFile('artifacts/programs/token_metadata.so',target);
if (process.argv.includes('--rebuild') || !(await exists(target)) || (await hash(target)) !== build.programSha256) {
  await mkdir(".local/vendor", { recursive: true });
  const source = ".local/vendor/mpl-token-metadata";
  if (!(await exists(source + "/.git")))
    await run("git", ["clone", "--no-checkout", build.repository, source]);
  const { stdout: head } = await exec("git", [
    "-C",
    source,
    "rev-parse",
    "HEAD",
  ]).catch(() => ({ stdout: "" }));
  if (head.trim() !== build.commit)
    await run("git", ["-C", source, "checkout", "--detach", build.commit]);
  if ((await hash("infra/metaplex-Cargo.lock")) !== build.lockfileSha256)
    throw new Error("Metaplex lockfile checksum mismatch");
  await copyFile(
    "infra/metaplex-Cargo.lock",
    source + "/programs/token-metadata/Cargo.lock",
  );
  await mkdir(".local/rust-bootstrap", { recursive: true });
  await mkdir(".local/downloads", { recursive: true });
  const root = process.cwd(),
    env = {
      ...process.env,
      CARGO_HOME: resolve(".local/cargo"),
      RUSTUP_HOME: resolve(".local/rustup"),
    };
  if (!(await exists(".local/cargo/bin/cargo"))) {
    const installer = ".local/rust-bootstrap/rustup-init";
    await download(
      "https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init",
      installer,
      build.rustupInitSha256,
    );
    await chmod(installer, 0o755);
    await run(
      resolve(installer),
      [
        "-y",
        "--no-modify-path",
        "--default-toolchain",
        "1.95.0",
        "--profile",
        "minimal",
      ],
      env,
    );
  }
  if (!(await exists(".local/platform-tools/rust/bin/rustc"))) {
    const archive = ".local/downloads/platform-tools-v1.57.tar.bz2";
    await download(build.platformToolsUrl, archive, build.platformToolsSha256);
    await mkdir(".local/platform-tools", { recursive: true });
    await run("tar", [
      "-xf",
      archive,
      "-C",
      ".local/platform-tools",
      "--no-same-owner",
    ]);
  }
  if (
    (await hash(".local/platform-tools/rust/bin/rustc")) !== build.rustcSha256
  )
    throw new Error("Solana rustc checksum mismatch");
  await run(
    resolve(".local/native/solana-release/bin/cargo-build-sbf"),
    [
      "--manifest-path",
      source + "/programs/token-metadata/program/Cargo.toml",
      "--sbf-out-dir",
      ".local/programs",
      "--no-rustup-override",
      "--skip-tools-install",
      "--tools-version",
      "v1.57",
      "--arch",
      "v1",
      "--jobs",
      "2",
      "--",
      "--locked",
    ],
    {
      ...env,
      PATH:
        resolve(".local/platform-tools/rust/bin") +
        ":" +
        resolve(".local/cargo/bin") +
        ":" +
        process.env.PATH,
      RUSTC: root + "/.local/platform-tools/rust/bin/rustc",
    },
  );
  if ((await hash(target)) !== build.programSha256)
    throw new Error(
      "Rebuilt metadata binary differs from the pinned build. Inspect its evidence before updating the lock.",
    );
}
await mkdir(".local/image-context/programs", { recursive: true });
await copyFile(target, ".local/image-context/programs/token_metadata.so");
await copyFile(
  "infra/metaplex-build.json",
  ".local/image-context/programs/build.json",
);
await writeFile(
  ".local/reports/chains/metadata-program.json",
  JSON.stringify(
    { ...build, state: "passed", verifiedAt: new Date().toISOString() },
    null,
    2,
  ) + "\n",
);
console.log("Pinned Metaplex program hash verified and staged.");
