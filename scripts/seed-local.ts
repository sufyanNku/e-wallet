import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { preflight } from "./preflight";
import { currentEpoch } from "../services/backend/src/environment";
import { networkRpc } from "../services/backend/src/node-rpc";
import { bitcoinIdentity } from "../services/backend/src/bitcoin-rpc";
import { localManifestSchema } from "../packages/domain/src/local-manifest";
const exec = promisify(execFile),
  compose = [
    "compose",
    "--project-name",
    "ewallet-demo",
    "--file",
    "infra/compose.yaml",
  ];
async function run(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Seed stage failed: " + args.join(" "))),
    );
  });
}
if (
  (process.env.EWALLET_MODE && process.env.EWALLET_MODE !== "local") ||
  process.env.EWALLET_ISOLATED_SOLANA_TEST ||
  process.env.EWALLET_ISOLATED_BITCOIN_TEST
)
  throw new Error("seed:local accepts only the main local namespace.");
await mkdir("artifacts/phase-04", { recursive: true });
await writeFile(
  "artifacts/phase-04/preflight.json",
  JSON.stringify(await preflight(), null, 2),
);
let healthy = true;
for (const service of ["evm-a", "evm-b", "solana", "bitcoin"]) {
  const { stdout } = await exec("docker", [...compose, "ps", "-q", service]);
  if (!stdout.trim()) {
    healthy = false;
    continue;
  }
  const { stdout: details } = await exec("docker", [
    "inspect",
    "--format",
    "{{json .Config.Labels}}",
    stdout.trim(),
  ]);
  if (JSON.parse(details)["org.ewallet.project"] !== "ewallet-demo")
    throw new Error("Unexpected container ownership: " + service);
}
if (!healthy) await run(["infra:up"]);
let changed = 0,
  known = 0;
for (const id of ["eip155:31337", "eip155:31338"]) {
  try {
    const old = JSON.parse(
      await readFile(
        "artifacts/deployments/" + id.replace(":", "-") + ".json",
        "utf8",
      ),
    );
    known++;
    if (old.bootEpoch !== (await currentEpoch(id)).bootEpoch) changed++;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
if (known === 2 && changed === 1) {
  await exec("docker", [...compose, "restart", "evm-a", "evm-b"]);
  console.log(
    "One EVM epoch changed; reconstructing both EVM demo chains as a matched pair. Persistent Solana/Bitcoin ledgers are retained.",
  );
}
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    if (
      BigInt(String(await networkRpc("eip155:31337", "eth_chainId"))) !==
        31337n ||
      BigInt(String(await networkRpc("eip155:31338", "eth_chainId"))) !== 31338n
    )
      throw new Error("Wrong EVM chain");
    await networkRpc("solana:local", "getGenesisHash");
    await bitcoinIdentity();
    break;
  } catch (e) {
    if (attempt === 39) throw e;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
const stages = [
  ["wallet-build", ["build:wallet"]],
  ["evm", ["deploy:local"]],
  ["solana", ["seed:solana"]],
  ["bitcoin", ["seed:bitcoin"]],
  ["assertions", ["seed:assert"]],
  [
    "index-evm",
    ["exec", "tsx", "scripts/check-indexers.ts", "evm", "--persist"],
  ],
  [
    "index-solana",
    ["exec", "tsx", "scripts/check-indexers.ts", "solana", "--persist"],
  ],
  [
    "index-bitcoin",
    ["exec", "tsx", "scripts/check-indexers.ts", "bitcoin", "--persist"],
  ],
  [
    "index-bitcoin-taproot",
    [
      "exec",
      "tsx",
      "scripts/check-indexers.ts",
      "bitcoin",
      "--persist",
      "--purpose=86",
    ],
  ],
] as const;
let journal: {
  schemaVersion: 1;
  seedVersion: 1;
  stages: Record<string, { state: string; completedAt: string }>;
} = { schemaVersion: 1, seedVersion: 1, stages: {} };
try {
  const prior = JSON.parse(await readFile(".local/seed-journal.json", "utf8"));
  if (prior.schemaVersion !== 1 || prior.seedVersion !== 1)
    throw new Error("Unknown seed journal version");
  journal = prior;
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
for (const [id, args] of stages) {
  await run([...args]);
  journal.stages[id] = {
    state: "confirmed",
    completedAt: new Date().toISOString(),
  };
  await writeFile(
    ".local/seed-journal.json.tmp",
    JSON.stringify(journal, null, 2),
  );
  await rename(".local/seed-journal.json.tmp", ".local/seed-journal.json");
}
const evm = JSON.parse(
    await readFile("artifacts/seed/evm-manifest.json", "utf8"),
  ),
  sol = JSON.parse(
    await readFile("artifacts/seed/solana-manifest.json", "utf8"),
  ),
  btc = JSON.parse(
    await readFile("artifacts/seed/bitcoin-manifest.json", "utf8"),
  ),
  scenarios: Array<{
    id: string;
    networkId: string;
    identifier: string;
    state: string;
    fee: string | null;
    evidenceStatus: "live" | "pruned";
  }> = [];
for (const deployment of evm.deployments) {
  const ledger = JSON.parse(
    await readFile(".local/seed-" + deployment.chainId + ".json", "utf8"),
  ).stages;
  for (const [id, stage] of Object.entries(ledger) as Array<
    [string, { hash: string; state: string; receipt?: { fee: string } }]
  >)
    scenarios.push({
      id,
      networkId: deployment.networkId,
      identifier: stage.hash,
      state: stage.state,
      fee: stage.receipt?.fee ?? null,
      evidenceStatus: "live",
    });
}
for (const [id, stage] of Object.entries(sol.stages) as Array<
  [
    string,
    {
      signature: string;
      state: string;
      fee?: string;
      historyAvailability?: string;
    },
  ]
>)
  scenarios.push({
    id,
    networkId: "solana:local",
    identifier: stage.signature,
    state: stage.state,
    fee: stage.fee ?? null,
    evidenceStatus: stage.historyAvailability === "pruned" ? "pruned" : "live",
  });
for (const [id, stage] of Object.entries(btc.stages) as Array<
  [string, { txid: string; state: string; fee?: string }]
>)
  scenarios.push({
    id,
    networkId: "bitcoin:regtest",
    identifier: stage.txid,
    state: stage.state,
    fee: stage.fee ?? null,
    evidenceStatus: "live",
  });
const manifest = localManifestSchema.parse({
  schemaVersion: 1,
  seedVersion: 1,
  runId: randomUUID(),
  createdAt: new Date().toISOString(),
  mode: "local",
  warning:
    "Public insecure local fixtures. Test assets have no monetary value.",
  nodes: [
    ...(await Promise.all(
      evm.deployments.map(
        async (d: { networkId: string; chainId: string }) => ({
          networkId: d.networkId,
          identity: d.chainId,
          bootEpoch: (await currentEpoch(d.networkId)).bootEpoch,
        }),
      ),
    )),
    { networkId: "solana:local", identity: sol.genesisHash, bootEpoch: null },
    {
      networkId: "bitcoin:regtest",
      identity: btc.genesisHash,
      bootEpoch: btc.fundingEpoch,
    },
  ],
  toolVersions: {
    node: process.version,
    pnpm: "10.34.9",
    hardhat: "3.22.0",
    solana: "4.4.1",
    bitcoin: "32.1",
  },
  publicIdentities: {
    evm: evm.identities,
    solana: sol.identities,
    bitcoin: btc.identities,
  },
  deployments: evm.deployments,
  tokens: [
    ...evm.deployments.flatMap((d: { assets: unknown[] }) => d.assets),
    ...Object.values(sol.mints),
  ],
  scenarios,
  openingAmounts: {
    alice: {
      nativeETH: "100000000000000000000",
      dUSDC: "10000000000",
      dDAI: "10000000000000000000000",
      EWLT: "2500000000000000000000",
      SOL: "100000000000",
      BTC_P2WPKH: "75000000",
      BTC_P2TR: "50000000",
    },
    note: "Opening allocations precede scenario sends, fees and rent.",
  },
  finalAmounts: {
    evm: await Promise.all(
      [31337, 31338].map(async (id) =>
        JSON.parse(
          await readFile(
            "artifacts/phase-03/final-balances-" + id + ".json",
            "utf8",
          ),
        ),
      ),
    ),
    solana: sol.finalBalances,
    bitcoin: btc.finalBalances,
  },
  syntheticMicroUsdRates: {
    ETH: "2000000000",
    POL: "500000",
    BNB: "300000000",
    HYPE: "10000000",
    SOL: "100000000",
    BTC: "40000000000",
    dUSDC: "1000000",
    dDAI: "1000000",
    EWLT: "100000",
    sEWLT: "100000",
  },
  assertions: {
    state: "passed",
    evidence: [
      "artifacts/phase-04/seed-assertions.json",
      "artifacts/phase-03/evm-assertions.json",
      "artifacts/phase-04/index-evm.json",
      "artifacts/phase-04/index-solana.json",
      "artifacts/phase-04/index-bitcoin.json",
    ],
  },
});
await mkdir(".local/infra", { recursive: true });
await writeFile(
  ".local/infra/state.json",
  JSON.stringify(
    {
      schemaVersion: 1,
      project: "ewallet-demo",
      observedAt: new Date().toISOString(),
      networks: Object.fromEntries(
        manifest.nodes.map((n) => [
          n.networkId,
          { identity: n.identity, bootEpoch: n.bootEpoch },
        ]),
      ),
    },
    null,
    2,
  ),
);
await mkdir("artifacts/seed", { recursive: true });
await writeFile(
  "artifacts/seed/local-manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  "Local dataset reconciled. " +
    scenarios.length +
    " real stages recorded. Run pnpm dev, then open http://127.0.0.1:5173. Local fixture phrases stay in ignored .local/secrets; use only public test identities.",
);
