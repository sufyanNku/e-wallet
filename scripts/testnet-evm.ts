import { abis } from "@ewallet/config/abis";
import { z } from "zod";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import {
  JsonRpcProvider,
  Wallet,
  HDNodeWallet,
  ContractFactory,
  Contract,
  Transaction,
  getCreateAddress,
  keccak256,
  type TransactionRequest,
} from "ethers";
import type { NetworkProfile } from "@ewallet/domain";
import { quoteBaseFees } from "../packages/chain-evm/src/base-fees";
type Stage = {
  hash: string;
  state: "signed" | "confirmed";
  fee?: string;
  contractAddress?: string | null;
  codeHash?: string;
};
export async function executeTestnetEvm(
  profile: NetworkProfile,
  mnemonic: string,
  recipient: string,
) {
  const directory = ".local/testnet/" + profile.identity;
  await mkdir(directory, { recursive: true });
  const path = directory + "/journal.json",
    provider = new JsonRpcProvider(profile.rpcs[0], BigInt(profile.identity), {
      staticNetwork: true,
      batchMaxCount: 1,
      cacheTimeout: 0,
    }),
    signer = Wallet.fromPhrase(mnemonic, provider);
  let journal: {
    schemaVersion: number;
    networkId: string;
    address: string;
    stages: Record<string, Stage>;
  } = {
    schemaVersion: 1,
    networkId: profile.id,
    address: signer.address,
    stages: {},
  };
  try {
    try {
      const existing = z
        .object({
          schemaVersion: z.literal(1),
          networkId: z.string(),
          address: z.string(),
          stages: z.record(
            z.string(),
            z
              .object({
                hash: z.string().regex(/^0x[0-9a-f]{64}$/),
                state: z.enum(["signed", "confirmed"]),
                fee: z.string().optional(),
                contractAddress: z.string().nullable().optional(),
                codeHash: z
                  .string()
                  .regex(/^0x[0-9a-f]{64}$/)
                  .optional(),
              })
              .strict(),
          ),
        })
        .strict()
        .parse(JSON.parse(await readFile(path, "utf8")));
      if (
        existing.schemaVersion !== 1 ||
        existing.networkId !== profile.id ||
        existing.address !== signer.address
      )
        throw new Error("Testnet journal identity changed");
      journal = existing;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const save = async () => {
      await writeFile(path + ".tmp", JSON.stringify(journal, null, 2));
      await rename(path + ".tmp", path);
    };
    async function transact(id: string, request: TransactionRequest) {
      let stage = journal.stages[id];
      if (stage?.state === "confirmed") {
        const receipt = await provider.getTransactionReceipt(stage.hash);
        if (receipt?.status !== 1)
          throw new Error(
            "Archived testnet receipt is unavailable or no longer canonical",
          );
        return receipt;
      }
      if (!stage) {
        if (
          BigInt(await provider.send("eth_chainId", [])) !==
          BigInt(profile.identity)
        )
          throw new Error("Wrong testnet identity");
        const gas = await provider.estimateGas({
            ...request,
            from: signer.address,
          }),
          limit = (gas * 120n + 99n) / 100n;
        if (limit > 5000000n)
          throw new Error("Testnet transaction exceeds 5M gas policy");
        const populated = await signer.populateTransaction({
            ...request,
            gasLimit: limit,
          }),
          executionMaximum =
            limit * BigInt(populated.maxFeePerGas ?? populated.gasPrice ?? 0),
          extra =
            profile.id === "eip155:84532"
              ? (
                  await quoteBaseFees(
                    provider,
                    Transaction.from({ ...populated, from: undefined })
                      .unsignedSerialized,
                    limit,
                  )
                ).maximumExtra
              : 0n,
          maximum = executionMaximum + extra;
        if (
          maximum === 0n ||
          maximum > BigInt(await provider.getBalance(signer.address)) / 2n
        )
          throw new Error(
            "Insufficient test funding for a bounded transaction and remaining stages",
          );
        const signed = await signer.signTransaction(populated),
          hash = Transaction.from(signed).hash!;
        await writeFile(directory + "/" + hash + ".signed", signed, {
          mode: 0o600,
        });
        stage = { hash, state: "signed" };
        journal.stages[id] = stage;
        await save();
      }
      let receipt = await provider.getTransactionReceipt(stage.hash);
      if (!receipt) {
        const signed = await readFile(
          directory + "/" + stage.hash + ".signed",
          "utf8",
        );
        if (Transaction.from(signed).hash !== stage.hash)
          throw new Error("Testnet recovery bytes changed");
        const known = await provider.getTransaction(stage.hash);
        if (!known) {
          try {
            await provider.send("eth_sendRawTransaction", [signed]);
          } catch {
            /* Reconcile the expected hash; no fresh signing. */
          }
        }
        receipt = await provider.waitForTransaction(
          stage.hash,
          profile.finality.confirmations,
          90000,
        );
      }
      if (receipt?.status !== 1)
        throw new Error(
          "Testnet transaction failed or remains uncertain; inspect its expected hash",
        );
      stage.state = "confirmed";
      stage.fee = String(receipt.fee);
      stage.contractAddress = receipt.contractAddress;
      await save();
      return receipt;
    }
    async function deploy(
      name: keyof typeof abis,
      args: unknown[],
      key: string = name,
    ) {
      const artifact = JSON.parse(
          await readFile(
            "contracts/artifacts/contracts/" +
              (["DemoERC20", "DemoNFT721", "DemoNFT1155"].includes(name)
                ? "DemoAssets"
                : name) +
              ".sol/" +
              name +
              ".json",
            "utf8",
          ),
        ),
        existing = journal.stages["deploy:" + key];
      let address = existing?.contractAddress;
      if (!address) {
        const factory = new ContractFactory(
            artifact.abi,
            artifact.bytecode,
            signer,
          ),
          request = await factory.getDeployTransaction(...args),
          receipt = await transact("deploy:" + key, request);
        address =
          receipt.contractAddress ??
          getCreateAddress({
            from: signer.address,
            nonce: (await provider.getTransaction(receipt.hash))!.nonce,
          });
      }
      const code = await provider.getCode(address);
      const stage = journal.stages["deploy:" + key];
      if (!stage.codeHash) {
        stage.codeHash = keccak256(code);
        await save();
      }
      if (code === "0x" || keccak256(code) !== stage.codeHash)
        throw new Error("Testnet deployment code differs");
      return new Contract(address, artifact.abi, signer);
    }
    const token = await deploy("DemoERC20", [
        "Test Demo USD",
        "tdUSD",
        6,
        1000000000000n,
        signer.address,
      ]),
      nft = await deploy("DemoNFT721", [signer.address]),
      multi = await deploy("DemoNFT1155", [
        signer.address,
        "https://example.invalid/configured/{id}.json",
      ]);
    await transact("mint:erc20", {
      to: await token.getAddress(),
      data: token.interface.encodeFunctionData("mint", [
        signer.address,
        10000000n,
      ]),
    });
    await transact("mint:erc721", {
      to: await nft.getAddress(),
      data: nft.interface.encodeFunctionData("mint", [
        signer.address,
        1n,
        "https://example.invalid/configured/access-pass.json",
      ]),
    });
    await transact("mint:erc1155", {
      to: await multi.getAddress(),
      data: multi.interface.encodeFunctionData("mint", [
        signer.address,
        1n,
        5n,
      ]),
    });
    await transact("native:send", { to: recipient, value: 1000000000000n });
    await transact("erc20:send", {
      to: await token.getAddress(),
      data: token.interface.encodeFunctionData("transfer", [recipient, 1n]),
    });
    await transact("erc721:send", {
      to: await nft.getAddress(),
      data: nft.interface.encodeFunctionData(
        "safeTransferFrom(address,address,uint256)",
        [signer.address, recipient, 1n],
      ),
    });
    await transact("erc1155:send", {
      to: await multi.getAddress(),
      data: multi.interface.encodeFunctionData("safeTransferFrom", [
        signer.address,
        recipient,
        1n,
        1n,
        "0x",
      ]),
    });
    await transact("allowance:approve", {
      to: await token.getAddress(),
      data: token.interface.encodeFunctionData("approve", [recipient, 1n]),
    });
    await transact("allowance:revoke", {
      to: await token.getAddress(),
      data: token.interface.encodeFunctionData("approve", [recipient, 0n]),
    });
    if (profile.id === "eip155:11155111") {
      const faucet = await deploy("DemoFaucet", [signer.address]),
        vault = await deploy("SavingsVault", [[await token.getAddress()]]),
        third = HDNodeWallet.fromPhrase(
          mnemonic,
          undefined,
          "m/44'/60'/0'/0/2",
        ),
        shared = await deploy("SharedWallet", [
          [signer.address, recipient, third.address],
        ]);
      await transact("service:faucet:configure", {
        to: await faucet.getAddress(),
        data: faucet.interface.encodeFunctionData("configure", [
          await token.getAddress(),
          1000000n,
        ]),
      });
      await transact("service:faucet:minter", {
        to: await token.getAddress(),
        data: token.interface.encodeFunctionData("grantRole", [
          await token.MINTER_ROLE(),
          await faucet.getAddress(),
        ]),
      });
      await transact("service:faucet:claim", {
        to: await faucet.getAddress(),
        data: faucet.interface.encodeFunctionData("claim", [
          await token.getAddress(),
        ]),
      });
      await transact("service:vault:approve", {
        to: await token.getAddress(),
        data: token.interface.encodeFunctionData("approve", [
          await vault.getAddress(),
          1000000n,
        ]),
      });
      await transact("service:vault:deposit", {
        to: await vault.getAddress(),
        data: vault.interface.encodeFunctionData("deposit", [
          await token.getAddress(),
          1000000n,
          60n,
        ]),
      });
      await transact("service:shared:fund", {
        to: await shared.getAddress(),
        value: 1000000000000n,
      });
      const dai = await deploy(
          "DemoERC20",
          [
            "Test Demo DAI",
            "tdDAI",
            18,
            1000000000000000000000000n,
            signer.address,
          ],
          "dDAI",
        ),
        pool = await deploy("DemoSwapPool", [
          await token.getAddress(),
          await dai.getAddress(),
        ]);
      await transact("service:pool:mint0", {
        to: await token.getAddress(),
        data: token.interface.encodeFunctionData("mint", [
          signer.address,
          1000000000n,
        ]),
      });
      await transact("service:pool:mint1", {
        to: await dai.getAddress(),
        data: dai.interface.encodeFunctionData("mint", [
          signer.address,
          1000000000000000000000n,
        ]),
      });
      for (const [asset, amount] of [
        [token, 1000000000n],
        [dai, 1000000000000000000000n],
      ] as const)
        await transact("service:pool:approve:" + (await asset.getAddress()), {
          to: await asset.getAddress(),
          data: asset.interface.encodeFunctionData("approve", [
            await pool.getAddress(),
            amount,
          ]),
        });
      await transact("service:pool:initialize", {
        to: await pool.getAddress(),
        data: pool.interface.encodeFunctionData("initialize", [
          1000000000n,
          1000000000000000000000n,
        ]),
      });
      await transact("service:swap:approve", {
        to: await token.getAddress(),
        data: token.interface.encodeFunctionData("approve", [
          await pool.getAddress(),
          1000000n,
        ]),
      });
      const quote = BigInt(
          await pool.quoteExactInput(await token.getAddress(), 1000000n),
        ),
        head = await provider.getBlock("latest");
      await transact("service:swap:execute", {
        to: await pool.getAddress(),
        data: pool.interface.encodeFunctionData("swapExactInput", [
          await token.getAddress(),
          1000000n,
          (quote * 99n) / 100n,
          head!.timestamp + 300,
          signer.address,
        ]),
      });
    }
    if (
      BigInt(await token.balanceOf(recipient)) !== 1n ||
      String(await nft.ownerOf(1n)).toLowerCase() !== recipient.toLowerCase() ||
      BigInt(await multi.balanceOf(recipient, 1n)) !== 1n ||
      BigInt(await token.allowance(signer.address, recipient)) !== 0n
    )
      throw new Error("Testnet final state differs");
    return {
      state: "passed" as const,
      networkId: profile.id,
      contracts: {
        erc20: await token.getAddress(),
        erc721: await nft.getAddress(),
        erc1155: await multi.getAddress(),
      },
      stages: journal.stages,
      assertions: {
        tokenOneBaseUnit: true,
        nftOwner: true,
        multiQuantity: true,
        allowanceZero: true,
      },
      source: "public-testnet",
    };
  } finally {
    provider.destroy();
  }
}
