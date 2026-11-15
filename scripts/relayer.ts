import {
  open,
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
} from "node:fs/promises";
import { JsonRpcProvider, Wallet, Interface, Transaction } from "ethers";
import { z } from "zod";
import { abis } from "@ewallet/config/abis";
import { observeBridge } from "../services/backend/src/bridge-observer";
const watch = process.argv.includes("--watch");
let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    running = false;
  });
async function relay() {
  await mkdir(".local/secrets", { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = await open(".local/relayer.lock", "wx", 0o600);
    await lock.writeFile(String(process.pid));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(await readFile(".local/relayer.lock", "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Unrecognized relayer lock; audit it before retrying.", {
        cause: e,
      });
    try {
      process.kill(pid, 0);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      await unlink(".local/relayer.lock");
      return;
    }
  }
  const provider = new JsonRpcProvider("http://127.0.0.1:8546", 31338, {
    staticNetwork: true,
    cacheTimeout: 0,
    batchMaxCount: 1,
  });
  try {
    if (BigInt(await provider.send("eth_chainId", [])) !== 31338n)
      throw new Error("Local destination identity changed");
    const observation = await observeBridge(),
      fixture = JSON.parse(
        await readFile(".local/secrets/deployer.json", "utf8"),
      ),
      signer = Wallet.fromPhrase(fixture.mnemonic, provider),
      schema = z
        .object({
          schemaVersion: z.literal(1),
          stages: z.record(
            z.string(),
            z
              .object({
                hash: z.string().regex(/^0x[0-9a-f]{64}$/),
                state: z.enum(["signed", "confirmed"]),
              })
              .strict(),
          ),
        })
        .strict();
    let journal: z.infer<typeof schema> = { schemaVersion: 1, stages: {} };
    try {
      journal = schema.parse(
        JSON.parse(await readFile(".local/relayer-journal.json", "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const save = async () => {
      await writeFile(
        ".local/relayer-journal.json.tmp",
        JSON.stringify(journal, null, 2),
      );
      await rename(
        ".local/relayer-journal.json.tmp",
        ".local/relayer-journal.json",
      );
    };
    for (const message of observation.messages) {
      if (message.state === "minted") continue;
      const key =
        observation.sourceEpoch +
        ":" +
        observation.destinationEpoch +
        ":" +
        message.id;
      let stage = journal.stages[key];
      if (!stage) {
        const data = new Interface(abis.DemoBridgeMint).encodeFunctionData(
            "mintFromLock",
            [message.id, message.nonce, message.recipient, message.amount],
          ),
          request = await signer.populateTransaction({
            to: observation.destinationContract,
            data,
          }),
          signed = await signer.signTransaction(request),
          hash = Transaction.from(signed).hash!;
        await writeFile(".local/secrets/relay-" + hash + ".signed", signed, {
          mode: 0o600,
        });
        stage = { hash, state: "signed" };
        journal.stages[key] = stage;
        await save();
      }
      let receipt = await provider.getTransactionReceipt(stage.hash);
      if (!receipt) {
        const current = await observeBridge(),
          same = current.messages.find((m) => m.id === message.id);
        if (
          current.sourceEpoch !== observation.sourceEpoch ||
          current.destinationEpoch !== observation.destinationEpoch ||
          same?.sourceBlockHash !== message.sourceBlockHash
        )
          throw new Error("Source reorg/epoch change prevents relay");
        if (same.state === "minted") continue;
        const signed = await readFile(
          ".local/secrets/relay-" + stage.hash + ".signed",
          "utf8",
        );
        if (Transaction.from(signed).hash !== stage.hash)
          throw new Error("Relayer recovery bytes changed");
        if (!(await provider.getTransaction(stage.hash))) {
          try {
            await provider.send("eth_sendRawTransaction", [signed]);
          } catch {
            /* Expected hash reconciliation handles uncertainty. */
          }
        }
        receipt = await provider.waitForTransaction(stage.hash, 1, 10000);
      }
      if (receipt?.status !== 1)
        throw new Error(
          "Destination mint remains uncertain or failed; no fresh signature was created",
        );
      stage.state = "confirmed";
      await save();
      await unlink(".local/secrets/relay-" + stage.hash + ".signed").catch(
        (e) => {
          if (e.code !== "ENOENT") throw e;
        },
      );
    }
    const result = await observeBridge();
    await writeFile(
      "artifacts/seed/bridge-status.json",
      JSON.stringify(result, null, 2),
    );
    return result;
  } finally {
    provider.destroy();
    await lock?.close();
    await unlink(".local/relayer.lock");
  }
}
do {
  try {
    const result = await relay();
    if (!watch && result)
      console.log(
        "Bridge simulation: " +
          result.messages.filter((m) => m.state === "minted").length +
          " canonical destination mints observed.",
      );
  } catch (e) {
    if (!watch) throw e;
    console.log(
      "Bridge relayer waiting: " +
        (e instanceof Error ? e.message : "local environment unavailable"),
    );
  }
  if (watch && running)
    await new Promise((resolve) => setTimeout(resolve, 5000));
} while (watch && running);
