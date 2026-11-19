import {z} from "zod";
import {
  JsonRpcProvider,
  HDNodeWallet,
  ContractFactory,
  Contract,
  Transaction,
  keccak256,
  toUtf8Bytes,
  parseEther,
  type TransactionReceipt,
} from "ethers";
import { mkdir, readFile, writeFile, chmod,rename,unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { currentEpoch } from "../services/backend/src/environment";
import {
  recoveryWords,
  derivePublic,
} from "../packages/wallet-core/src/derivation";
import {
  deploymentSchema,
  type DeploymentManifest,
} from "@ewallet/domain/deployments";
import { abis } from "@ewallet/config/abis";
const encode = (data: unknown) =>
  JSON.stringify(
    data,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ) + "\n";
export const roots = Object.fromEntries(
  ["alice", "bob", "carol", "dana", "deployer"].map((name, i) => {
    const entropyHex = (i === 4 ? "10" : String(i + 1).padStart(2, "0")).repeat(
      32,
    );
    const secret = {
        entropyHex,
        passphrase: "",
        derivationVersion: 1 as const,
      },
      phrase = recoveryWords(secret).join(" ");
    return [
      name,
      {
        secret,
        phrase,
        wallet: HDNodeWallet.fromPhrase(phrase, undefined, "m/44'/60'/0'/0/0"),
      },
    ];
  }),
);
type Stage = {
  state: "signed" | "confirmed";
  hash: string;
  receipt?: {
    status: number | null;
    blockNumber: string;
    blockHash: string;
    fee: string;
    contractAddress: string | null;
  };
};
type Journal = {
  schemaVersion: 1;
  networkId: string;
  bootEpoch: string;
  stages: Record<string, Stage>;
  allocations: string[];
};
const journalSchema=z.object({schemaVersion:z.literal(1),networkId:z.string(),bootEpoch:z.string().regex(/^[0-9a-f]{64}$/),allocations:z.array(z.string().max(100)).max(100),stages:z.record(z.string().max(100),z.object({state:z.enum(['signed','confirmed']),hash:z.string().regex(/^0x[0-9a-f]{64}$/),receipt:z.object({status:z.number().int().min(0).max(1).nullable(),blockNumber:z.string().regex(/^[0-9]+$/),blockHash:z.string().regex(/^0x[0-9a-f]{64}$/),fee:z.string().regex(/^[0-9]+$/),contractAddress:z.string().nullable()}).strict().optional()}).strict())}).strict();
export async function seedEvm() {
  await mkdir(".local/secrets", { recursive: true, mode: 0o700 });
  await chmod(".local/secrets", 0o700);
  for (const [name, root] of Object.entries(roots)) {
    const path = `.local/secrets/${name}.json`;
    await writeFile(
      path,
      encode({
        warning: "PUBLIC INSECURE LOCAL TEST IDENTITY ONLY",
        mnemonic: root.phrase,
      }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
  }
  const manifests: DeploymentManifest[] = [];
  const publicScenarios: Record<string, unknown>[] = [];
  let sourceLock = "";
  let sourceEvent:{id:string;nonce:bigint;recipient:string;amount:bigint;hash:string;blockHash:string;bootEpoch:string}|null=null;
  for (const chainId of [31337, 31338]) {
    const networkId = `eip155:${chainId}`,
      provider = new JsonRpcProvider(
        `http://127.0.0.1:${chainId === 31337 ? 8545 : 8546}`,
        chainId,
        { staticNetwork: true, batchMaxCount: 1, cacheTimeout: 0 },
      );
    if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(chainId))
      throw new Error("Refusing to seed an unexpected chain");
    const { bootEpoch } = await currentEpoch(networkId),
      genesis = await provider.getBlock(0);
    if (!genesis?.hash) throw new Error("Missing local genesis");
    const journalPath = `.local/seed-${chainId}.json`;
    let journal: Journal = {
      schemaVersion: 1,
      networkId,
      bootEpoch,
      stages: {},
      allocations: [],
    };
    try {
      const previous=journalSchema.parse(JSON.parse(await readFile(journalPath,'utf8')));
      if(previous.networkId!==networkId)throw new Error('Journal network differs.');
      if(previous.bootEpoch===bootEpoch)journal=previous;
    }catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw new Error('Invalid EVM seed journal; refusing duplicate allocations.',{cause:error});}
    const save=async()=>{await writeFile(journalPath+'.tmp',encode(journal));await rename(journalPath+'.tmp',journalPath);};
    const signer = roots.deployer.wallet.connect(provider);
    const accounts = Object.fromEntries(
      Object.entries(roots).map(([name, root]) => [
        name,
        root.wallet.connect(provider),
      ]),
    );
    for (const name of ["deployer", "alice", "bob", "carol"])
      if (!journal.allocations.includes(name)) {
        await provider.send("hardhat_setBalance", [
          accounts[name].address,
          name === "deployer"
            ? "0x" + parseEther("1000").toString(16)
            : "0x" + parseEther("100").toString(16),
        ]);
        journal.allocations.push(name);
        await save();
      }
    async function transact(
      stageId: string,
      request: Parameters<HDNodeWallet["populateTransaction"]>[0],
      who = signer,
      expectedRevert = false,
    ) {
      async function finish(receipt:TransactionReceipt){
        if(receipt.status!==(expectedRevert?0:1))throw new Error('Unexpected execution result: '+stageId);
        if((await provider.getBlock(receipt.blockNumber))?.hash!==receipt.blockHash)throw new Error('Seed receipt is no longer canonical: '+stageId);
        journal.stages[stageId]={state:'confirmed',hash:receipt.hash,receipt:{status:receipt.status,blockNumber:String(receipt.blockNumber),blockHash:receipt.blockHash,fee:receipt.fee.toString(),contractAddress:receipt.contractAddress}};
        await save();await unlink(`.local/secrets/${chainId}-${receipt.hash}.signed`).catch(error=>{if(error.code!=='ENOENT')throw error;});return receipt;
      }
      const existing=journal.stages[stageId];
      if(existing){
        const receipt=await provider.getTransactionReceipt(existing.hash);if(receipt)return finish(receipt);
        const saved=await readFile(`.local/secrets/${chainId}-${existing.hash}.signed`,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if(!saved||Transaction.from(saved).hash!==existing.hash)throw new Error('Uncertain submission without matching reconciliation bytes: '+stageId);
        await provider.broadcastTransaction(saved).catch(()=>{});
        const resumed=await provider.waitForTransaction(existing.hash,1,10000);if(!resumed)throw new Error('Submission remains uncertain: '+stageId);return finish(resumed);
      }
      const populated = await who.populateTransaction(request),
        signed = await who.signTransaction(populated),
        hash = Transaction.from(signed).hash!;
      await writeFile(`.local/secrets/${chainId}-${hash}.signed`, signed, {
        mode: 0o600,
      });
      journal.stages[stageId] = { state: "signed", hash };
      await save();
      try {
        await provider.broadcastTransaction(signed);
      } catch {
        if (!(await provider.getTransactionReceipt(hash)))
          throw new Error(
            `Submission uncertain; rerun seed to reconcile ${stageId}`,
          );
      }
      const receipt = await provider.waitForTransaction(hash, 1, 10000);
      if (!receipt) throw new Error(`Receipt unavailable for ${stageId}`);
      return finish(receipt);
    }
    const contracts: DeploymentManifest["contracts"] = {};
    async function deploy(name: keyof typeof abis, args: unknown[]) {
      const files: Record<keyof typeof abis, string> = {
        DemoERC20: "DemoAssets.sol",
        DemoNFT721: "DemoAssets.sol",
        DemoNFT1155: "DemoAssets.sol",
        DemoFaucet: "DemoFaucet.sol",
        SavingsVault: "SavingsVault.sol",
        SharedWallet: "SharedWallet.sol",
        DemoSwapPool: "DemoSwapPool.sol",
        DemoBridgeLock: "DemoBridge.sol",
        DemoBridgeMint: "DemoBridge.sol",
      };
      const artifact = JSON.parse(
        await readFile(
          `contracts/artifacts/contracts/${files[name]}/${name}.json`,
          "utf8",
        ),
      ) as { abi: (typeof abis)[typeof name]; bytecode: string };
      const receipt = await transact(
        `deploy:${name}`,
        await new ContractFactory(
          artifact.abi,
          artifact.bytecode,
          signer,
        ).getDeployTransaction(...args),
      );
      if (!receipt.contractAddress)
        throw new Error(`No deployment address: ${name}`);
      const code = await provider.getCode(receipt.contractAddress);
      if (code === "0x") throw new Error(`Missing deployed code: ${name}`);
      contracts[name] = {
        address: receipt.contractAddress,
        codeHash: keccak256(code),
        transactionHash: receipt.hash,
        abiHash: keccak256(toUtf8Bytes(JSON.stringify(artifact.abi))),
        blockNumber: String(receipt.blockNumber),
        constructorArguments: args,
      };
      return new Contract(receipt.contractAddress, artifact.abi, signer);
    }
    async function token(
      key: string,
      name: string,
      symbol: string,
      decimals: number,
    ) {
      const stageKey = `deploy:${key}`;
      const artifact = JSON.parse(
        await readFile(
          "contracts/artifacts/contracts/DemoAssets.sol/DemoERC20.json",
          "utf8",
        ),
      ) as { abi: typeof abis.DemoERC20; bytecode: string };
      const args = [
          name,
          symbol,
          decimals,
          1_000_000_000n * 10n ** BigInt(decimals),
          signer.address,
        ],
        r = await transact(
          stageKey,
          await new ContractFactory(
            artifact.abi,
            artifact.bytecode,
            signer,
          ).getDeployTransaction(...args),
        );
      if (!r.contractAddress) throw new Error("Token deployment failed");
      contracts[key] = {
        address: r.contractAddress,
        codeHash: keccak256(await provider.getCode(r.contractAddress)),
        transactionHash: r.hash,
        abiHash: keccak256(toUtf8Bytes(JSON.stringify(artifact.abi))),
        blockNumber: String(r.blockNumber),
        constructorArguments: args,
      };
      return new Contract(r.contractAddress, artifact.abi, signer);
    }
    const assets: DeploymentManifest["assets"] = [];
    if (chainId === 31337) {
      const usdc = await token("dUSDC", "Demo USD Coin", "dUSDC", 6),
        dai = await token("dDAI", "Demo Dai", "dDAI", 18),
        ewlt = await token("EWLT", "e-wallet Demo Token", "EWLT", 18),
        impostor = await token("Impostor", "Demo Unverified Token", "USDC", 6);
      const nft = await deploy("DemoNFT721", [signer.address]),
        multi = await deploy("DemoNFT1155", [
          signer.address,
          "http://127.0.0.1:8787/fixtures/{id}.json",
        ]),
        faucet = await deploy("DemoFaucet", [signer.address]),
        vault = await deploy("SavingsVault", [
          [await usdc.getAddress(), await dai.getAddress()],
        ]),
        shared = await deploy("SharedWallet", [
          [
            accounts.alice.address,
            accounts.bob.address,
            accounts.carol.address,
          ],
        ]),
        pool = await deploy("DemoSwapPool", [
          await usdc.getAddress(),
          await dai.getAddress(),
        ]),
        lock = await deploy("DemoBridgeLock", [await usdc.getAddress(), 31338]);
      sourceLock = await lock.getAddress();
      const tx = async (
        id: string,
        c: Contract,
        method: string,
        args: unknown[],
        who = signer,
        extra: Record<string, unknown> = {},
      ) =>
        transact(
          id,
          {
            ...(await c.getFunction(method).populateTransaction(...args)),
            ...extra,
          },
          who,
        );
      for (const [key, c, symbol, decimals] of [
        ["dUSDC", usdc, "dUSDC", 6],
        ["dDAI", dai, "dDAI", 18],
        ["EWLT", ewlt, "EWLT", 18],
      ] as const) {
        assets.push({
          standard: "erc20",
          reference: await c.getAddress(),
          name:
            key === "dUSDC"
              ? "Demo USD Coin"
              : key === "dDAI"
                ? "Demo Dai"
                : "e-wallet Demo Token",
          symbol,
          decimals,
          hidden: false,
        });
        for (const [name, amount] of [
          ["alice", key === "EWLT" ? 2500n : 10000n],
          ["bob", key === "EWLT" ? 1000n : 5000n],
          ["carol", key === "EWLT" ? 1000n : 5000n],
        ] as const)
          await tx(`opening:${key}:${name}`, c, "mint", [
            accounts[name].address,
            amount * 10n ** BigInt(decimals),
          ]);
        await tx(`role:${key}:faucet`, c, "grantRole", [
          await c.MINTER_ROLE(),
          await faucet.getAddress(),
        ]);
        await tx(`faucet:${key}:config`, faucet, "configure", [
          await c.getAddress(),
          100n * 10n ** BigInt(decimals),
        ]);
      }
      assets.push(
        {
          standard: "erc20",
          reference: await impostor.getAddress(),
          name: "Demo Unverified Token",
          symbol: "USDC",
          decimals: 6,
          hidden: true,
        },
        {
          standard: "erc721",
          reference: await nft.getAddress(),
          name: "Demo Access Pass",
          symbol: "dCAMP",
          decimals: 0,
          tokenIds: ["101", "102", "103"],
          hidden: false,
        },
        {
          standard: "erc1155",
          reference: await multi.getAddress(),
          name: "Demo Membership",
          symbol: "dSTUDY",
          decimals: 0,
          tokenIds: ["1", "2"],
          hidden: false,
        },
      );
      await tx("opening:impostor", impostor, "mint", [
        accounts.alice.address,
        7_000_000n,
      ]);
      for (const [id, name] of [
        [101n, "alice"],
        [102n, "alice"],
        [103n, "bob"],
      ] as const)
        await tx(`opening:nft:${id}`, nft, "mint", [
          accounts[name].address,
          id,
          "http://127.0.0.1:8787/fixtures/access-pass.json",
        ]);
      for (const [name, id, qty] of [
        ["alice", 1n, 5n],
        ["alice", 2n, 10n],
        ["bob", 1n, 2n],
      ] as const)
        await tx(`opening:1155:${name}:${id}`, multi, "mint", [
          accounts[name].address,
          id,
          qty,
        ]);
      for (const [symbol, c, decimals] of [
        ["dUSDC", usdc, 6],
        ["dDAI", dai, 18],
      ] as const) {
        const amount =
          1_000_000n * 10n ** BigInt(decimals) +
          (symbol === "dUSDC" ? 1000n * 10n ** 6n : 0n);
        await tx(`opening:pool-mint:${symbol}`, c, "mint", [
          signer.address,
          amount,
        ]);
        await tx(`opening:pool-approve:${symbol}`, c, "approve", [
          await pool.getAddress(),
          1_000_000n * 10n ** BigInt(decimals),
        ]);
      }
      await tx("opening:pool-init", pool, "initialize", [
        1_000_000n * 10n ** 6n,
        1_000_000n * 10n ** 18n,
      ]);
      await transact(
        "SEED-01",
        { to: accounts.bob.address, value: parseEther("0.1") },
        accounts.alice,
      );
      await tx(
        "SEED-02",
        usdc,
        "transfer",
        [accounts.alice.address, 125_000_000n],
        accounts.bob,
      );
      await tx(
        "SEED-03",
        ewlt,
        "transfer",
        [accounts.carol.address, 1n],
        accounts.alice,
      );
      await tx(
        "SEED-04-721",
        nft,
        "safeTransferFrom(address,address,uint256)",
        [accounts.alice.address, accounts.bob.address, 102n],
        accounts.alice,
      );
      await tx(
        "SEED-04-1155",
        multi,
        "safeTransferFrom",
        [accounts.alice.address, accounts.carol.address, 1n, 2n, "0x"],
        accounts.alice,
      );
      await tx(
        "SEED-05-claim",
        faucet,
        "claim",
        [await usdc.getAddress()],
        accounts.alice,
      );
      await transact(
        "SEED-05-cooldown",
        {
          ...(await faucet.claim.populateTransaction(await usdc.getAddress())),
          gasLimit: 200000n,
        },
        accounts.alice,
        true,
      );
      await tx(
        "SEED-06-allowance",
        usdc,
        "approve",
        [await vault.getAddress(), 300_000_000n],
        accounts.alice,
      );
      for (const [id, duration] of [
        [0, 60],
        [1, 60],
        [2, 3600],
      ])
        await tx(
          `SEED-06-deposit:${id}`,
          vault,
          "deposit",
          [await usdc.getAddress(), 100_000_000n, duration],
          accounts.alice,
        );
      if (!journal.allocations.includes("advance:61")) {
        const position=await vault.positions(0),latest=await provider.getBlock('latest');if(!latest)throw new Error('Missing latest block');
        if(BigInt(latest.timestamp)<BigInt(position.unlockAt)){await provider.send('evm_setNextBlockTimestamp',[Number(position.unlockAt)]);await provider.send('evm_mine',[]);}
        journal.allocations.push("advance:61");
        await save();
      }
      await tx("SEED-06-withdraw", vault, "withdraw", [0], accounts.alice);
      await tx(
        "SEED-07-approve",
        usdc,
        "approve",
        [await pool.getAddress(), 100_000_000n],
        accounts.alice,
      );
      if (!journal.stages["SEED-07-swap"]) {
        const output = BigInt(
            await pool.quoteExactInput(await usdc.getAddress(), 100_000_000n),
          ),
          block = await provider.getBlock("latest");
        await tx(
          "SEED-07-swap",
          pool,
          "swapExactInput",
          [
            await usdc.getAddress(),
            100_000_000n,
            (output * 995n) / 1000n,
            BigInt(block!.timestamp + 300),
            accounts.alice.address,
          ],
          accounts.alice,
        );
      } else await transact("SEED-07-swap", {});
      await transact("SEED-08-native", {
        to: await shared.getAddress(),
        value: parseEther("1"),
      });
      await tx("SEED-08-token", usdc, "transfer", [
        await shared.getAddress(),
        1_000_000_000n,
      ]);
      for (const [id, name, recipient, amount] of [
        [0, "A", "bob", 50_000_000n],
        [1, "B", "carol", 25_000_000n],
      ] as const) {
        await tx(
          `SEED-09-proposal:${name}`,
          shared,
          "propose",
          [
            await usdc.getAddress(),
            0n,
            usdc.interface.encodeFunctionData("transfer", [
              accounts[recipient].address,
              amount,
            ]),
          ],
          accounts.alice,
        );
        await tx(
          `SEED-09-approve:alice:${name}`,
          shared,
          "approve",
          [id],
          accounts.alice,
        );
        if (id === 1) {
          await tx(
            "SEED-09-approve:bob:B",
            shared,
            "approve",
            [id],
            accounts.bob,
          );
          await tx(
            "SEED-09-execute:B",
            shared,
            "execute",
            [id],
            accounts.alice,
          );
        }
      }
      await tx(
        "SEED-10-approve",
        usdc,
        "approve",
        [await lock.getAddress(), 25_000_000n],
        accounts.alice,
      );
      const lockReceipt=await tx(
        "SEED-10-lock",
        lock,
        "lock",
        [25_000_000n, accounts.alice.address, 31338],
        accounts.alice,
      );
      const sourceLog=lockReceipt.logs.filter(log=>log.address.toLowerCase()===sourceLock.toLowerCase()).map(log=>lock.interface.parseLog(log)).find(log=>log?.name==='Locked');
      if(!sourceLog||sourceLog.args.recipient!==accounts.alice.address||BigInt(sourceLog.args.amount)!==25_000_000n||BigInt(sourceLog.args.destinationChain)!==31338n)throw new Error('Canonical bridge source event differs from expected binding.');
      sourceEvent={id:String(sourceLog.args.messageId),nonce:BigInt(sourceLog.args.nonce),recipient:String(sourceLog.args.recipient),amount:BigInt(sourceLog.args.amount),hash:lockReceipt.hash,blockHash:lockReceipt.blockHash,bootEpoch};
      await tx(
        "SEED-14-allowance",
        usdc,
        "approve",
        [accounts.bob.address, 25_000_000n],
        accounts.alice,
      );
      for (const [name, c] of [
        ["dUSDC", usdc],
        ["dDAI", dai],
        ["EWLT", ewlt],
        ["Impostor", impostor],
        ["DemoNFT721", nft],
        ["DemoNFT1155", multi],
      ] as const)
        await tx(`roles:revoke-deployer:${name}`, c, "revokeRole", [
          await c.MINTER_ROLE(),
          signer.address,
        ]);
    } else {
      if (!sourceLock)
        throw new Error("Missing paired source bridge deployment");
      const tokenB = await token(
          "bdUSDC",
          "Demo Bridged USD Coin",
          "bdUSDC",
          6,
        ),
        mint = await deploy("DemoBridgeMint", [
          await tokenB.getAddress(),
          sourceLock,
          signer.address,
        ]);
      assets.push({
        standard: "erc20",
        reference: await tokenB.getAddress(),
        name: "Demo Bridged USD Coin",
        symbol: "bdUSDC",
        decimals: 6,
        hidden: false,
      });
      await transact(
        "role:bridge-mint",
        await tokenB.grantRole.populateTransaction(
          await tokenB.MINTER_ROLE(),
          await mint.getAddress(),
        ),
      );
      if(!sourceEvent)throw new Error('Missing observed bridge source event');
      const sourceProvider=new JsonRpcProvider('http://127.0.0.1:8545',31337,{staticNetwork:true,cacheTimeout:0});
      try{
        if(BigInt(await sourceProvider.send('eth_chainId',[]))!==31337n||(await currentEpoch('eip155:31337')).bootEpoch!==sourceEvent.bootEpoch)throw new Error('Paired source chain changed before relaying.');
        const receipt=await sourceProvider.getTransactionReceipt(sourceEvent.hash);if(!receipt||receipt.status!==1||receipt.blockHash!==sourceEvent.blockHash||(await sourceProvider.getBlock(receipt.blockNumber))?.hash!==receipt.blockHash)throw new Error('Bridge source event is absent or reorged.');
        if(keccak256(await sourceProvider.getCode(sourceLock))!==manifests[0].contracts.DemoBridgeLock.codeHash)throw new Error('Bridge source bytecode changed.');
        await transact('SEED-10-mint',await mint.mintFromLock.populateTransaction(sourceEvent.id,sourceEvent.nonce,sourceEvent.recipient,sourceEvent.amount));
      }finally{sourceProvider.destroy();}
      await transact(
        "roles:revoke-deployer:bdUSDC",
        await tokenB.revokeRole.populateTransaction(
          await tokenB.MINTER_ROLE(),
          signer.address,
        ),
      );
    }
    const manifest = deploymentSchema.parse({
      schemaVersion: 1,
      networkId,
      chainId: String(chainId),
      genesisHash: genesis.hash,
      bootEpoch,
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      compiler: { version: "0.8.38", evmVersion: "paris" },
      deploymentBlock: Object.values(contracts).reduce(
        (min, c) => (BigInt(c.blockNumber) < BigInt(min) ? c.blockNumber : min),
        String(await provider.getBlockNumber()),
      ),
      contracts,
      assets,
    });
    await mkdir(".local/state/deployments", { recursive: true });
    const file = `.local/state/deployments/eip155-${chainId}.json`;
    let previous: DeploymentManifest | null = null;
    try {
      previous = deploymentSchema.parse(
        JSON.parse(await readFile(file, "utf8")),
      );
    } catch {
      /* New deployment. */
    }
    if (previous?.bootEpoch === bootEpoch)
      for (const [name, c] of Object.entries(previous.contracts)) {
        if (contracts[name]?.codeHash !== c.codeHash)
          throw new Error(`Unexpected existing bytecode: ${name}`);
      }
    await writeFile(file, encode(manifest));
    manifests.push(manifest);
    for (const [id, stage] of Object.entries(journal.stages))
      if (id.startsWith("SEED-"))
        publicScenarios.push({ id, networkId, ...stage });
    console.log(
      `${networkId}: deployments and ${Object.keys(journal.stages).length} real transaction stages reconciled.`,
    );
    provider.destroy();
  }
  const identities = Object.fromEntries(
    Object.entries(roots)
      .filter(([name]) => name !== "deployer")
      .map(([name, root]) => [
        name,
        {
          evm: derivePublic(root.secret, `fixture-${name}`, {
            family: "evm",
            index: 0,
          }),
          solana: derivePublic(root.secret, `fixture-${name}`, {
            family: "solana",
            index: 0,
          }),
          segwit: derivePublic(root.secret, `fixture-${name}`, {
            family: "bitcoin",
            index: 0,
          }),
          taproot: derivePublic(root.secret, `fixture-${name}`, {
            family: "bitcoin",
            index: 0,
            bitcoinType: "p2tr",
          }),
        },
      ]),
  );
  await mkdir(".local/state/seed", { recursive: true });
  await writeFile(
    ".local/state/seed/evm-manifest.json",
    encode({
      schemaVersion: 1,
      seedVersion: 1,
      source: "node",
      mode: "local",
      identities,
      deployments: manifests,
      scenarios: publicScenarios,
    }),
  );
  return { manifests, identities, scenarios: publicScenarios };
}
if (process.argv[1]?.endsWith("/seed-evm.ts")) await seedEvm();
