import { signReviewedBitcoin } from "../packages/wallet-core/src/bitcoin-signer";
import { mkdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { z } from "zod";
import {
  bitcoinRpc,
  bitcoinIdentity,
  BitcoinRpcError,
  ensurePublicDescriptor,
} from "../services/backend/src/bitcoin-rpc";
import { roots } from "./seed-evm";
import {
  derivePublic,
  bitcoinPublicWatch,
} from "../packages/wallet-core/src/derivation";
import {
  deriveWatchAddress,
  REGTEST_GENESIS,
  bitcoin,
  satoshis,
  validateWatch,
  selectCoins,
  buildPsbt,
  bitcoinPayloadSchema,
  type BitcoinUtxo,
} from "@ewallet/chain-bitcoin";
const stage = z.object({
    txid: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum(["signed", "confirmed"]),
    fee: z.string().optional(),
  }),
  schema = z
    .object({
      schemaVersion: z.literal(1),
      genesisHash: z.literal(REGTEST_GENESIS),
      fundingEpoch: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      stages: z.record(z.string(), stage),
    })
    .strict();
const encode = (v: unknown) =>
  JSON.stringify(
    v,
    (_, value) => (typeof value === "bigint" ? String(value) : value),
    2,
  ) + "\n";
export async function seedBitcoin() {
  await bitcoinIdentity();
  await mkdir(".local/secrets", { recursive: true, mode: 0o700 });
  await mkdir("artifacts/seed", { recursive: true });
  const wallets = (await bitcoinRpc("listwallets")) as string[],
    directories = (await bitcoinRpc("listwalletdir")) as {
      wallets: Array<{ name: string }>;
    };
  for (const [name, watchOnly] of [
    ["ewallet-miner", false],
    ["ewallet-watch", true],
  ] as const) {
    if (!wallets.includes(name)) {
      if (directories.wallets.some((w) => w.name === name))
        await bitcoinRpc("loadwallet", [name]);
      else
        await bitcoinRpc("createwallet", [
          name,
          watchOnly,
          watchOnly,
          "",
          false,
          true,
          true,
        ]);
    }
  }
  const watchInfo = (await bitcoinRpc(
    "getwalletinfo",
    [],
    "ewallet-watch",
  )) as { private_keys_enabled: boolean };
  if (watchInfo.private_keys_enabled !== false)
    throw new Error("Refusing a watch wallet that has private keys.");
  const minerAddress = z
      .string()
      .parse(
        await bitcoinRpc(
          "getnewaddress",
          ["ewallet-demo-mining", "bech32"],
          "ewallet-miner",
        ),
      ),
    height = BigInt((await bitcoinIdentity()).blocks);
  if (height < 101n)
    await bitcoinRpc("generatetoaddress", [
      Number(101n - height),
      minerAddress,
    ]);
  const isolated = process.env.EWALLET_ISOLATED_BITCOIN_TEST === "1",
    journalPath = isolated
      ? ".local/seed-bitcoin-browser.json"
      : ".local/seed-bitcoin.json",
    fundingEpoch = String(await bitcoinRpc("getblockhash", [1]));
  let journal: z.infer<typeof schema> = {
    schemaVersion: 1,
    genesisHash: REGTEST_GENESIS,
    stages: {},
  };
  try {
    const previous = schema.parse(
      JSON.parse(await readFile(journalPath, "utf8")),
    );
    if (!previous.fundingEpoch || previous.fundingEpoch === fundingEpoch)
      journal = previous;
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw new Error(
        "Invalid Bitcoin seed journal; refusing fresh allocations.",
        { cause: error },
      );
  }
  journal.fundingEpoch = fundingEpoch;
  const save = async () => {
    await writeFile(journalPath + ".tmp", encode(journal));
    await rename(journalPath + ".tmp", journalPath);
  };
  const identities: Record<string, ReturnType<typeof bitcoinPublicWatch>[]> =
    {};
  for (const [name, root] of Object.entries(roots).filter(
    ([name]) => name !== "deployer",
  )) {
    identities[name] = [];
    for (const type of ["p2wpkh", "p2tr"] as const) {
      const account = derivePublic(root.secret, "fixture-" + name, {
          family: "bitcoin",
          index: 0,
          bitcoinType: type,
        }),
        watch = validateWatch(bitcoinPublicWatch(root.secret, account));
      identities[name].push(watch);
      for (const branch of [0, 1] as const)
        await ensurePublicDescriptor(watch, branch);
    }
  }
  async function funding(id: string, address: string, amount: string) {
    const existing = journal.stages[id];
    if (existing) {
      let transaction: { txid: string };
      try {
        transaction = (await bitcoinRpc("getrawtransaction", [
          existing.txid,
          true,
        ])) as { txid: string };
      } catch (error) {
        if (
          !(error instanceof BitcoinRpcError) ||
          error.code !== "-5" ||
          existing.state !== "signed"
        )
          throw error;
        const bytes = await readFile(
          `.local/secrets/btc-${existing.txid}.signed`,
          "utf8",
        );
        if (bitcoin.Transaction.fromHex(bytes).getId() !== existing.txid)
          throw new Error("Reconciliation bytes differ from expected txid", {
            cause: error,
          });
        await bitcoinRpc("sendrawtransaction", [bytes]);
        transaction = (await bitcoinRpc("getrawtransaction", [
          existing.txid,
          true,
        ])) as { txid: string };
      }
      if (transaction.txid !== existing.txid)
        throw new Error("Existing transaction identity mismatch");
      return;
    }
    const funded = (await bitcoinRpc(
      "walletcreatefundedpsbt",
      [[], [{ [address]: amount }], 0, { fee_rate: 2 }, true],
      "ewallet-miner",
    )) as { psbt: string; fee: string };
    const signed = (await bitcoinRpc(
      "walletprocesspsbt",
      [funded.psbt, true, "ALL", true],
      "ewallet-miner",
    )) as { psbt: string; complete: boolean };
    if (!signed.complete) throw new Error("Seeder PSBT was not signed");
    const final = (await bitcoinRpc("finalizepsbt", [signed.psbt])) as {
      hex: string;
      complete: boolean;
    };
    if (!final.complete) throw new Error("Seeder PSBT was not finalized");
    const txid = bitcoin.Transaction.fromHex(final.hex).getId();
    await writeFile(`.local/secrets/btc-${txid}.signed`, final.hex, {
      mode: 0o600,
    });
    journal.stages[id] = { txid, state: "signed", fee: satoshis(funded.fee) };
    await save();
    const acceptance = (await bitcoinRpc("testmempoolaccept", [
      [final.hex],
    ])) as Array<{ allowed: boolean }>;
    if (acceptance[0]?.allowed !== true)
      throw new Error("Seeder transaction refused by regtest mempool");
    if ((await bitcoinRpc("sendrawtransaction", [final.hex])) !== txid)
      throw new Error("Unexpected seeder txid");
    console.log("Bitcoin funding submitted: " + id);
  }
  for (const [id, name, purpose, amount] of [
    ["alice-wpkh-0", "alice", 84, "0.50"],
    ["alice-wpkh-1", "alice", 84, "0.25"],
    ["alice-tr-0", "alice", 86, "0.40"],
    ["alice-tr-1", "alice", 86, "0.10"],
    ["bob-wpkh", "bob", 84, "0.10"],
    ["carol-wpkh", "carol", 84, "0.10"],
  ] as const) {
    const watch = identities[name].find((w) => w.purpose === purpose)!;
    await funding(id, deriveWatchAddress(watch, 0, 0).address, amount);
  }
  let depth = 6;
  for (const s of Object.values(journal.stages)) {
    const tx = (await bitcoinRpc("getrawtransaction", [s.txid, true])) as {
      confirmations?: string;
    };
    depth = Math.min(depth, Number(tx.confirmations ?? "0"));
  }
  if (depth < 6)
    await bitcoinRpc("generatetoaddress", [6 - depth, minerAddress]);
  for (const s of Object.values(journal.stages)) {
    const receipt = (await bitcoinRpc("getrawtransaction", [s.txid, true])) as {
      confirmations?: string;
    };
    if (BigInt(receipt.confirmations ?? "0") < 6n)
      throw new Error("Funding lacks six regtest confirmations");
    s.state = "confirmed";
    await unlink(`.local/secrets/btc-${s.txid}.signed`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await save();
  for (const [purpose, recipientName, amount] of [
    [84, "bob", 1000000n],
    [86, "carol", 2000000n],
  ] as const) {
    const id = "SEED-13-" + purpose,
      existing = journal.stages[id];
    if (existing) {
      try {
        await bitcoinRpc("getrawtransaction", [existing.txid, true]);
      } catch (error) {
        if (
          !(error instanceof BitcoinRpcError) ||
          error.code !== "-5" ||
          existing.state !== "signed"
        )
          throw error;
        const bytes = await readFile(
          `.local/secrets/btc-${existing.txid}.signed`,
          "utf8",
        );
        if (bitcoin.Transaction.fromHex(bytes).getId() !== existing.txid)
          throw new Error("Scenario recovery bytes changed", { cause: error });
        await bitcoinRpc("sendrawtransaction", [bytes]);
      }
      continue;
    }
    const watch = identities.alice.find((w) => w.purpose === purpose)!,
      paths = ([0, 1] as const).flatMap((branch) =>
        Array.from({ length: 20 }, (_, i) =>
          deriveWatchAddress(watch, branch, i),
        ),
      ),
      outputs = (await bitcoinRpc(
        "listunspent",
        [1, 9999999, paths.map((p) => p.address)],
        "ewallet-watch",
      )) as Array<{
        txid: string;
        vout: string;
        address: string;
        scriptPubKey: string;
        amount: string;
        confirmations: string;
      }>,
      utxos: BitcoinUtxo[] = [];
    for (const output of outputs) {
      const derived = paths.find((p) => p.address === output.address)!;
      utxos.push({
        txid: output.txid,
        vout: Number(output.vout),
        address: output.address,
        scriptHex: output.scriptPubKey,
        value: satoshis(output.amount),
        confirmations: output.confirmations,
        path: derived.path,
        change: derived.change,
        addressIndex: derived.addressIndex,
        rawTransaction: String(
          await bitcoinRpc("getrawtransaction", [output.txid, false]),
        ),
      });
    }
    const recipient = deriveWatchAddress(
        identities[recipientName][0],
        0,
        0,
      ).address,
      selection = selectCoins(
        utxos,
        amount,
        recipient,
        deriveWatchAddress(watch, 1, 0).address,
        purpose,
        2n,
      ),
      payload = bitcoinPayloadSchema.parse({
        family: "bitcoin",
        genesisHash: REGTEST_GENESIS,
        ledgerFingerprint: fundingEpoch,
        watch,
        watchId: "0".repeat(64),
        psbt: buildPsbt(watch, selection, recipient, 0).toBase64(),
        inputs: selection.inputs,
        recipient,
        amount: String(amount),
        change: String(selection.change),
        changeIndex: 0,
        fee: String(selection.fee),
        feeRate: "2",
        estimatedVbytes: String(selection.estimatedVbytes),
      }),
      account = derivePublic(roots.alice.secret, "fixture-alice", {
        family: "bitcoin",
        index: 0,
        bitcoinType: purpose === 84 ? "p2wpkh" : "p2tr",
      }),
      signed = signReviewedBitcoin(roots.alice.secret, account, payload);
    await writeFile(`.local/secrets/btc-${signed.txid}.signed`, signed.signed, {
      mode: 0o600,
    });
    journal.stages[id] = {
      txid: signed.txid,
      state: "signed",
      fee: payload.fee,
    };
    await save();
    const accepted = (await bitcoinRpc("testmempoolaccept", [
      [signed.signed],
    ])) as Array<{ allowed: boolean }>;
    if (!accepted[0]?.allowed) throw new Error("Scenario rejected by Core");
    if (
      (await bitcoinRpc("sendrawtransaction", [signed.signed])) !== signed.txid
    )
      throw new Error("Scenario identifier changed");
  }
  let scenarioDepth = 6;
  for (const s of Object.values(journal.stages)) {
    const t = (await bitcoinRpc("getrawtransaction", [s.txid, true])) as {
      confirmations?: string;
    };
    scenarioDepth = Math.min(scenarioDepth, Number(t.confirmations ?? "0"));
  }
  if (scenarioDepth < 6)
    await bitcoinRpc("generatetoaddress", [6 - scenarioDepth, minerAddress]);
  for (const s of Object.values(journal.stages)) {
    const t = (await bitcoinRpc("getrawtransaction", [s.txid, true])) as {
      confirmations?: string;
    };
    if (BigInt(t.confirmations ?? "0") < 6n)
      throw new Error("Scenario lacks six confirmations");
    s.state = "confirmed";
    await unlink(`.local/secrets/btc-${s.txid}.signed`).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  await save();
  const unspent = (await bitcoinRpc(
      "listunspent",
      [1, 9999999, [], true],
      "ewallet-watch",
    )) as Array<{
      txid: string;
      vout: string;
      address: string;
      amount: string;
      confirmations: string;
      scriptPubKey: string;
    }>,
    finalBalances = [];
  for (const [name, watches] of Object.entries(identities))
    for (const watch of watches) {
      const derived = deriveWatchAddress(watch, 0, 0),
        utxos = unspent
          .filter((u) =>
            ([0, 1] as const).some((branch) =>
              Array.from(
                { length: 20 },
                (_, i) => deriveWatchAddress(watch, branch, i).address,
              ).includes(u.address),
            ),
          )
          .map((u) => ({ ...u, value: satoshis(u.amount) })),
        total = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n),
        expected =
          name === "alice"
            ? watch.purpose === 84
              ? 74000000n - BigInt(journal.stages["SEED-13-84"].fee!)
              : 48000000n - BigInt(journal.stages["SEED-13-86"].fee!)
            : ["bob", "carol"].includes(name) && watch.purpose === 84
              ? name === "bob"
                ? 11000000n
                : 12000000n
              : 0n;
      if (total !== expected)
        throw new Error(
          "Regtest final balance/fee reconciliation mismatch: " +
            name +
            ":" +
            watch.purpose,
        );
      finalBalances.push({
        name,
        purpose: watch.purpose,
        address: derived.address,
        path: derived.path,
        total: String(total),
        utxos,
      });
    }
  const manifest = {
    schemaVersion: 1,
    networkId: "bitcoin:regtest",
    genesisHash: REGTEST_GENESIS,
    fundingEpoch,
    observedAt: new Date().toISOString(),
    height: (await bitcoinIdentity()).blocks,
    watchWalletPrivateKeysEnabled: false,
    identities,
    stages: journal.stages,
    finalBalances,
  };
  await writeFile(
    isolated
      ? "artifacts/phase-03/isolated-bitcoin-manifest.json"
      : "artifacts/seed/bitcoin-manifest.json",
    encode(manifest),
  );
  console.log(
    "Bitcoin: public descriptors, six funding transactions, script-type allocations and watch-only policy verified.",
  );
  return manifest;
}
if (process.argv[1]?.endsWith("/seed-bitcoin.ts")) await seedBitcoin();
