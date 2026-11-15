import { Interface, keccak256 } from "ethers";
import { readFile } from "node:fs/promises";
import { deploymentSchema } from "@ewallet/domain/deployments";
import { abis } from "@ewallet/config/abis";
import { currentEpoch } from "./environment";
import { networkRpc } from "./node-rpc";
const seen = new Map<string, number>();
export async function observeBridge() {
  const manifests = await Promise.all(
      [31337, 31338].map(async (id) =>
        deploymentSchema.parse(
          JSON.parse(
            await readFile(
              "artifacts/deployments/eip155-" + id + ".json",
              "utf8",
            ),
          ),
        ),
      ),
    ),
    [source, destination] = manifests;
  for (const manifest of manifests)
    if (
      (await currentEpoch(manifest.networkId)).bootEpoch !== manifest.bootEpoch
    )
      throw new Error("Bridge chain pair needs reseeding");
  const sourceContract = source.contracts.DemoBridgeLock,
    destinationContract = destination.contracts.DemoBridgeMint;
  for (const [network, entry] of [
    [source.networkId, sourceContract],
    [destination.networkId, destinationContract],
  ] as const)
    if (
      keccak256(
        String(
          await networkRpc(network, "eth_getCode", [entry.address, "latest"]),
        ),
      ) !== entry.codeHash
    )
      throw new Error("Bridge contract code changed");
  const logs = async (network: string, contract: string, start: string) => {
    const height = BigInt(String(await networkRpc(network, "eth_blockNumber"))),
      first = BigInt(start);
    if (height - first > 5000n)
      throw new Error("Bridge history exceeds the bounded local range");
    const results: Array<{
      address: string;
      topics: string[];
      data: string;
      transactionHash: string;
      blockHash: string;
      blockNumber: string;
    }> = [];
    for (let from = first; from <= height; from += 1000n)
      results.push(
        ...((await networkRpc(network, "eth_getLogs", [
          {
            address: contract,
            fromBlock: "0x" + from.toString(16),
            toBlock:
              "0x" + (from + 999n < height ? from + 999n : height).toString(16),
          },
        ])) as typeof results),
      );
    return results;
  };
  const sourceLogs = await logs(
      source.networkId,
      sourceContract.address,
      source.deploymentBlock,
    ),
    destinationLogs = await logs(
      destination.networkId,
      destinationContract.address,
      destination.deploymentBlock,
    ),
    lock = new Interface(abis.DemoBridgeLock),
    mint = new Interface(abis.DemoBridgeMint),
    messages = [];
  for (const log of sourceLogs) {
    const event = lock.parseLog(log);
    if (event?.name !== "Locked") continue;
    const id = String(event.args.messageId),
      nonce = String(event.args.nonce),
      recipient = String(event.args.recipient),
      amount = String(event.args.amount),
      block = (await networkRpc(source.networkId, "eth_getBlockByNumber", [
        log.blockNumber,
        false,
      ])) as { hash: string } | null;
    if (block?.hash !== log.blockHash)
      throw new Error("Bridge source inclusion changed");
    if (BigInt(event.args.destinationChain) !== 31338n)
      throw new Error("Wrong bridge destination");
    const receipt = (await networkRpc(
      source.networkId,
      "eth_getTransactionReceipt",
      [log.transactionHash],
    )) as { status: string; blockHash: string };
    if (BigInt(receipt.status) !== 1n || receipt.blockHash !== log.blockHash)
      throw new Error("Bridge source receipt is not canonical");
    const consumed = Boolean(
        mint.decodeFunctionResult(
          "consumed",
          String(
            await networkRpc(destination.networkId, "eth_call", [
              {
                to: destinationContract.address,
                data: mint.encodeFunctionData("consumed", [id]),
              },
              "latest",
            ]),
          ),
        )[0],
      ),
      minted = destinationLogs.find((item) => {
        const e = mint.parseLog(item);
        return e?.name === "Minted" && e.args.messageId === id;
      });
    if (consumed && !minted)
      throw new Error(
        "Consumed bridge message lacks its canonical destination event",
      );
    let destinationHash: string | null = null;
    if (minted) {
      const included = (await networkRpc(
        destination.networkId,
        "eth_getBlockByNumber",
        [minted.blockNumber, false],
      )) as { hash: string } | null;
      if (included?.hash !== minted.blockHash)
        throw new Error("Bridge destination inclusion changed");
      destinationHash = minted.transactionHash;
    }
    const key = source.bootEpoch + ":" + destination.bootEpoch + ":" + id;
    if (!seen.has(key)) seen.set(key, Date.now());
    messages.push({
      id,
      nonce,
      sender: String(event.args.sender),
      recipient,
      amount,
      sourceHash: log.transactionHash,
      sourceBlockHash: log.blockHash,
      destinationHash,
      state: consumed
        ? "minted"
        : Date.now() - seen.get(key)! >= 60000
          ? "timeout"
          : "waiting",
      firstObservedAt: new Date(seen.get(key)!).toISOString(),
    });
  }
  return {
    sourceNetworkId: source.networkId,
    destinationNetworkId: destination.networkId,
    sourceEpoch: source.bootEpoch,
    destinationEpoch: destination.bootEpoch,
    sourceContract: sourceContract.address,
    destinationContract: destinationContract.address,
    observedAt: new Date().toISOString(),
    source: "node",
    messages,
  };
}
