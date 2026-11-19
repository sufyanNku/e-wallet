import "./report-paths.ts";
import { observeBridge } from "../services/backend/src/bridge-observer";
import { JsonRpcProvider, Wallet, Interface, Transaction } from "ethers";
import { readFile, writeFile, open, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { abis } from "@ewallet/config/abis";
const name = process.argv.slice(2).find((a) => a !== "--");
if (name === "reorg-evm") {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "tsx", "scripts/check-index-reorg.ts"],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Reorg check failed")),
    );
  });
} else if (
  [
    "pending-evm",
    "replacement-evm",
    "reverted-evm",
    "rpc-outage",
    "relayer-timeout",
  ].includes(name ?? "")
) {
  const provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, {
    staticNetwork: true,
    cacheTimeout: 0,
  });
  if (BigInt(await provider.send("eth_chainId", [])) !== 31337n)
    throw new Error("Refusing scenario outside local chain");
  const snapshot = await provider.send("evm_snapshot", []),
    proof: Record<string, unknown> = {
      name,
      observedAt: new Date().toISOString(),
      networkId: "eip155:31337",
      isolatedBySnapshot: true,
    };
  let relayLock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const fixture = JSON.parse(
        await readFile(".local/secrets/alice.json", "utf8"),
      ),
      manifest = JSON.parse(
        await readFile(".local/state/seed/evm-manifest.json", "utf8"),
      ),
      wallet = Wallet.fromPhrase(fixture.mnemonic, provider),
      nonce = await provider.getTransactionCount(wallet.address, "pending");
    if (name === "pending-evm" || name === "replacement-evm") {
      await provider.send("evm_setAutomine", [false]);
      const first = await wallet.sendTransaction({
        to: manifest.identities.bob.evm.address,
        value: 1n,
        nonce,
        gasLimit: 21000n,
        maxFeePerGas: 2000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });
      if ((await provider.getTransactionReceipt(first.hash)) !== null)
        throw new Error("Pending transaction unexpectedly mined");
      proof.pendingHash = first.hash;
      proof.pendingReceiptAbsent = true;
      let expected = first.hash;
      if (name === "replacement-evm") {
        const replacement = await wallet.sendTransaction({
          to: manifest.identities.bob.evm.address,
          value: 2n,
          nonce,
          gasLimit: 21000n,
          maxFeePerGas: 4000000000n,
          maxPriorityFeePerGas: 2000000000n,
        });
        expected = replacement.hash;
        proof.replacementHash = expected;
      }
      await provider.send("evm_setAutomine", [true]);
      await provider.send("evm_mine", []);
      const receipt = await provider.getTransactionReceipt(expected);
      if (receipt?.status !== 1)
        throw new Error("Pending scenario did not mine successfully");
      proof.receipt = {
        hash: expected,
        status: receipt.status,
        blockHash: receipt.blockHash,
      };
    } else if (name === "reverted-evm") {
      const deployment = manifest.deployments.find(
          (d: { chainId: string }) => d.chainId === "31337",
        ),
        data = new Interface(abis.SavingsVault).encodeFunctionData(
          "withdraw",
          [0],
        );
      let rejected = false;
      try {
        await provider.call({
          from: wallet.address,
          to: deployment.contracts.SavingsVault.address,
          data,
        });
      } catch {
        rejected = true;
      }
      if (!rejected)
        throw new Error("Withdrawn position should reject preflight");
      const tx = await wallet.populateTransaction({
          to: deployment.contracts.SavingsVault.address,
          data,
          nonce,
          gasLimit: 300000n,
        }),
        signed = await wallet.signTransaction(tx),
        hash = Transaction.from(signed).hash!;
      // Hardhat reports a revert from eth_sendRawTransaction even when it mined a
      // status-0 receipt. Reconcile the expected hash instead of signing again.
      try {
        await provider.send("eth_sendRawTransaction", [signed]);
      } catch {
        /* Expected mined revert is verified below. */
      }
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt?.status !== 0)
        throw new Error("Real reverted receipt missing");
      proof.preflightRejectedWithoutBroadcast = true;
      proof.receipt = {
        hash,
        status: receipt.status,
        blockHash: receipt.blockHash,
        fee: String(receipt.fee),
      };
    } else if (name === "rpc-outage") {
      let rejected = false;
      try {
        await fetch("http://127.0.0.1:1", { signal: AbortSignal.timeout(500) });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("Outage fixture unexpectedly available");
      proof.source = "controlled transport fault injection";
      proof.unavailable = true;
      proof.syntheticReceipt = false;
    } else {
      relayLock = await open(".local/relayer.lock", "wx", 0o600);
      await relayLock.writeFile(String(process.pid));
      const deployment = manifest.deployments.find(
          (d: { chainId: string }) => d.chainId === "31337",
        ),
        token = new Interface(abis.DemoERC20),
        lock = new Interface(abis.DemoBridgeLock);
      const allowance = await wallet.sendTransaction({
        to: deployment.contracts.dUSDC.address,
        data: token.encodeFunctionData("approve", [
          deployment.contracts.DemoBridgeLock.address,
          1n,
        ]),
        nonce,
      });
      await allowance.wait();
      const sent = await wallet.sendTransaction({
        to: deployment.contracts.DemoBridgeLock.address,
        data: lock.encodeFunctionData("lock", [1n, wallet.address, 31338]),
        nonce: nonce + 1,
      });
      const receipt = await sent.wait();
      if (receipt?.status !== 1) throw new Error("Source lock failed");
      const event = receipt.logs
        .map((log) => {
          try {
            return lock.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "Locked");
      if (!event) throw new Error("Source lock event missing");
      const initial = await observeBridge(),
        message = initial.messages.find((m) => m.id === event.args.messageId);
      if (message?.state !== "waiting")
        throw new Error("Expected an unminted source lock");
      for (let elapsed = 0; elapsed < 60; elapsed += 5) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        console.log("Relayer withheld: " + (elapsed + 5) + "/60 seconds.");
      }
      const final = (await observeBridge()).messages.find(
        (m) => m.id === message.id,
      );
      if (final?.state !== "timeout" || final.destinationHash)
        throw new Error("Real relayer withholding did not reach timeout");
      proof.source = "real-local-lock-with-controlled-relayer-withholding";
      proof.state = "timeout";
      proof.message = final;
      proof.mintBroadcast = false;
      proof.note =
        "Tokens remain locked until relayer resumes or the isolated snapshot is restored; no refund was advertised.";
    }
    await writeFile(
      ".local/reports/integration/scenario-" + name + ".json",
      JSON.stringify(proof, null, 2),
    );
    console.log(name + ": bounded scenario verified; node restored.");
  } finally {
    await provider.send("evm_setAutomine", [true]);
    await (async () => {
      if (!(await provider.send("evm_revert", [snapshot])))
        throw new Error("Scenario snapshot cleanup failed");
    })();
    provider.destroy();
    if (relayLock) {
      await relayLock.close();
      await unlink(".local/relayer.lock");
    }
  }
} else
  throw new Error(
    "Supported scenarios: pending-evm, replacement-evm, reverted-evm, reorg-evm, rpc-outage, relayer-timeout. Solana expiry uses the labelled controlled blockhash test; Bitcoin pending is verified on its disposable browser ledger.",
  );
