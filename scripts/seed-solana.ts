import "./report-paths.ts";
import {
  readFile,
  writeFile,
  mkdir,
  chmod,
  unlink,
  rename,
} from "node:fs/promises";
import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  signTransaction,
  getTransactionEncoder,
  getSignatureFromTransaction,
  getProgramDerivedAddress,
  getAddressEncoder,
  getAddressDecoder,
  getUtf8Encoder,
  AccountRole,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  getCreateAccountInstruction,
  getTransferSolInstruction,
} from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  getInitializeMint2Instruction,
  getMintToInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  findAssociatedTokenPda,
  getApproveInstruction,
  getFreezeAccountInstruction,
  getSetAuthorityInstruction,
  getTransferCheckedInstruction,
  getMintDecoder,
  getTokenDecoder,
} from "@solana-program/token";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getInitializeNonTransferableMintInstruction,
} from "@solana-program/token-2022";
import {
  getCreateMetadataAccountV3InstructionDataEncoder,
  getCreateMasterEditionV3InstructionDataEncoder,
  getMetadataDecoder,
  getMasterEditionDecoder,
} from "@metaplex-foundation/mpl-token-metadata-kit";
import { HDKey } from "micro-key-producer/slip10.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { solanaManifestSchema } from "@ewallet/domain";
import { roots } from "./seed-evm";
import {
  seedBytes,
  derivePublic,
} from "../packages/wallet-core/src/derivation";
import { rpcUpstream } from "../services/backend/src/rpc";
import { fromBase64, toBase64 } from "@ewallet/chain-solana";
const isolated = process.argv.includes("--isolated-browser-test");
const raw = z.string().regex(/^(0|[1-9][0-9]*)$/),
  signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
  META = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const stageSchema = z.object({
  signature,
  lastValidBlockHeight: raw,
  state: z.enum(["signed", "confirmed"]),
  fee: raw.nullable().optional(),
  historyAvailability: z.enum(["live", "pruned"]).optional(),
});
const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    genesisHash: z.string(),
    stages: z.record(z.string(), stageSchema),
  })
  .strict();
async function rpc(method: string, params: unknown[] = []) {
  const response = (await rpcUpstream(
    isolated ? "http://127.0.0.1:18899" : "http://127.0.0.1:8899",
    method,
    params,
    undefined,
    true,
  )) as { result?: unknown; error?: unknown };
  if (response.error) throw new Error(`Local Solana RPC failed: ${method}`);
  return response.result;
}
async function account(reference: string) {
  return z
    .object({
      value: z
        .object({
          owner: z.string(),
          executable: z.boolean(),
          data: z.tuple([z.string(), z.literal("base64")]),
        })
        .nullable(),
    })
    .parse(
      await rpc("getAccountInfo", [
        reference,
        { encoding: "base64", commitment: "confirmed" },
      ]),
    ).value;
}
const encode = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v), 2) +
  "\n";
async function signer(name: string, index = 0) {
  const seed = seedBytes(roots[name].secret),
    root = HDKey.fromMasterSeed(seed),
    child = root.derive(`m/44'/501'/${index}'/0'`);
  try {
    return await createKeyPairSignerFromPrivateKeyBytes(child.privateKey);
  } finally {
    seed.fill(0);
    child.privateKey.fill(0);
    root.privateKey.fill(0);
  }
}
async function pda(mint: string, edition = false) {
  return (
    await getProgramDerivedAddress({
      programAddress: META,
      seeds: [
        getUtf8Encoder().encode("metadata"),
        getAddressEncoder().encode(META),
        getAddressEncoder().encode(address(mint)),
        ...(edition ? [getUtf8Encoder().encode("edition")] : []),
      ],
    })
  )[0];
}
export async function seedSolana() {
  const genesisHash = z.string().parse(await rpc("getGenesisHash"));
  const metadataProgram = await account(META);
  if (!metadataProgram?.executable)
    throw new Error("Pinned metadata program is not loaded.");
  const expectedProgram = JSON.parse(
    await readFile("infra/metaplex-build.json", "utf8"),
  );
  let loadedBytes = fromBase64(metadataProgram.data[0]);
  if (metadataProgram.owner === "BPFLoaderUpgradeab1e11111111111111111111111") {
    if (
      loadedBytes.length !== 36 ||
      new DataView(loadedBytes.buffer).getUint32(0, true) !== 2
    )
      throw new Error("Invalid upgradeable program account");
    const programData = await account(
      getAddressDecoder().decode(loadedBytes.slice(4)),
    );
    if (!programData || programData.owner !== metadataProgram.owner)
      throw new Error("Invalid program data owner");
    const data = fromBase64(programData.data[0]);
    if (
      data.length < 45 ||
      new DataView(data.buffer).getUint32(0, true) !== 3 ||
      (data[12] !== 0 &&
        !(data[12] === 1 && data.slice(13, 45).every((b) => b === 0)))
    )
      throw new Error("Local metadata program is unexpectedly upgradeable");
    loadedBytes = data.slice(45);
  }
  if (
    createHash("sha256").update(loadedBytes).digest("hex") !==
    expectedProgram.programSha256
  )
    throw new Error(
      "Loaded metadata program bytes differ from the pinned build.",
    );
  await mkdir(".local/secrets", { recursive: true, mode: 0o700 });
  await chmod(".local/secrets", 0o700);
  await mkdir(".local/state/seed", { recursive: true });
  const journalPath = isolated
    ? ".local/seed-solana-browser.json"
    : ".local/seed-solana.json";
  let journal: z.infer<typeof journalSchema> = {
    schemaVersion: 1,
    genesisHash,
    stages: {},
  };
  try {
    const previous = journalSchema.parse(
      JSON.parse(await readFile(journalPath, "utf8")),
    );
    if (previous.genesisHash === genesisHash) journal = previous;
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
        "Solana seed journal is invalid; refusing to repeat allocations.",
        { cause: error },
      );
  }
  const save = async () => {
      await writeFile(journalPath + ".tmp", encode(journal));
      await rename(journalPath + ".tmp", journalPath);
    },
    actors: Record<string, KeyPairSigner> = {};
  for (const name of Object.keys(roots)) actors[name] = await signer(name);
  async function wait(sig: string) {
    for (let poll = 0; poll < 160; poll++) {
      const response = z
        .object({
          value: z.array(
            z
              .object({
                err: z.unknown().nullable(),
                confirmationStatus: z.string().nullable(),
              })
              .nullable(),
          ),
        })
        .parse(
          await rpc("getSignatureStatuses", [
            [sig],
            { searchTransactionHistory: true },
          ]),
        );
      const status = response.value[0];
      if (status?.err !== null && status?.err !== undefined)
        throw new Error("Seed transaction reverted: " + sig);
      if (
        status &&
        ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      "Seed signature remains uncertain; rerun reconciles without fresh signing.",
    );
  }
  async function tx(
    id: string,
    instructions: Instruction[],
    signers: KeyPairSigner[] = [actors.deployer],
  ) {
    const existing = journal.stages[id];
    if (existing) {
      const status = z
        .object({ value: z.array(z.unknown().nullable()) })
        .parse(
          await rpc("getSignatureStatuses", [
            [existing.signature],
            { searchTransactionHistory: true },
          ]),
        );
      if (!status.value[0] && existing.state === "confirmed") {
        existing.historyAvailability = "pruned";
        await save();
        return existing.signature;
      }
      if (!status.value[0]) {
        if (
          BigInt(
            raw.parse(
              await rpc("getBlockHeight", [{ commitment: "confirmed" }]),
            ),
          ) > BigInt(existing.lastValidBlockHeight)
        )
          throw new Error(
            "Expired uncertain seed stage requires explicit ledger audit: " +
              id,
          );
        const bytes = await readFile(
          `.local/secrets/sol-${existing.signature}.signed`,
          "utf8",
        );
        await rpc("sendTransaction", [
          bytes,
          { encoding: "base64", preflightCommitment: "confirmed" },
        ]);
      }
      await wait(existing.signature);
      existing.state = "confirmed";
      const transaction = z
        .object({ meta: z.object({ fee: raw }) })
        .parse(
          await rpc("getTransaction", [
            existing.signature,
            { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
          ]),
        );
      existing.fee = transaction.meta.fee;
      existing.historyAvailability = "live";
      await save();
      await unlink(`.local/secrets/sol-${existing.signature}.signed`).catch(
        (error) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      return existing.signature;
    }
    const latest = z
      .object({
        value: z.object({ blockhash: z.string(), lastValidBlockHeight: raw }),
      })
      .parse(await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]));
    const message = appendTransactionMessageInstructions(
      instructions,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.value.blockhash),
          lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          signers[0].address,
          createTransactionMessage({ version: 0 }),
        ),
      ),
    );
    const signed = await signTransaction(
        signers.map((s) => s.keyPair),
        compileTransaction(message),
      ),
      sig = getSignatureFromTransaction(signed),
      bytes = toBase64(getTransactionEncoder().encode(signed));
    await writeFile(`.local/secrets/sol-${sig}.signed`, bytes, { mode: 0o600 });
    journal.stages[id] = {
      signature: sig,
      state: "signed",
      lastValidBlockHeight: latest.value.lastValidBlockHeight,
    };
    await save();
    const observed = await rpc("sendTransaction", [
      bytes,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
      },
    ]);
    if (observed !== sig)
      throw new Error("Seed signature differs from expected identifier");
    await wait(sig);
    journal.stages[id].state = "confirmed";
    journal.stages[id].fee = z
      .object({ meta: z.object({ fee: raw }) })
      .parse(
        await rpc("getTransaction", [
          sig,
          { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
        ]),
      ).meta.fee;
    await save();
    await unlink(`.local/secrets/sol-${sig}.signed`);
    console.log("Solana stage reconciled: " + id);
    return sig;
  }
  // Airdrops are local-validator-only; they are never exposed by the backend RPC policy.
  if (!journal.stages["funding:deployer"]) {
    const balance = BigInt(
      z
        .object({ value: raw })
        .parse(
          await rpc("getBalance", [
            actors.deployer.address,
            { commitment: "confirmed" },
          ]),
        ).value,
    );
    if (balance === 0n) {
      const sig = signature.parse(
        await rpc("requestAirdrop", [
          actors.deployer.address,
          500000000000,
          { commitment: "confirmed" },
        ]),
      );
      await wait(sig);
      journal.stages["funding:deployer"] = {
        signature: sig,
        state: "confirmed",
        lastValidBlockHeight: "0",
        fee: "0",
      };
      await save();
    } else
      throw new Error(
        "Unjournaled local deployer funding; audit before seeding.",
      );
  }
  for (const name of ["alice", "bob", "carol"])
    await tx("opening:SOL:" + name, [
      getTransferSolInstruction({
        source: actors.deployer,
        destination: actors[name].address,
        amount: 100000000000n,
      }),
    ]);
  const mints: Record<
    string,
    {
      address: string;
      decimals: number;
      program: string;
      name: string;
      symbol: string;
    }
  > = {};
  async function mint(
    key: string,
    index: number,
    decimals: number,
    name: string,
    symbol: string,
    is2022 = false,
    unsupported = false,
  ) {
    const keypair = await signer("deployer", index),
      program = is2022 ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS,
      space = unsupported ? 170n : 82n,
      rent = BigInt(
        raw.parse(
          await rpc("getMinimumBalanceForRentExemption", [Number(space)]),
        ),
      );
    const create = getCreateAccountInstruction({
        payer: actors.deployer,
        newAccount: keypair,
        lamports: rent,
        space,
        programAddress: program,
      }),
      init = getInitializeMint2Instruction(
        {
          mint: keypair.address,
          decimals,
          mintAuthority: actors.deployer.address,
          freezeAuthority: actors.deployer.address,
        },
        { programAddress: program },
      );
    await tx(
      "mint:" + key,
      [
        create,
        ...(unsupported
          ? [
              getInitializeNonTransferableMintInstruction({
                mint: keypair.address,
              }),
            ]
          : []),
        init,
      ],
      [actors.deployer, keypair],
    );
    mints[key] = { address: keypair.address, decimals, program, name, symbol };
    return keypair.address;
  }
  await mint("dUSDC", 10, 6, "Demo USD Coin", "dUSDC");
  await mint("sEWLT", 11, 9, "Solana e-wallet Demo Token", "sEWLT");
  await mint(
    "token2022",
    12,
    6,
    "Demo Extension-free Token-2022",
    "d2022",
    true,
  );
  await mint(
    "unsupported",
    13,
    6,
    "Demo Nontransferable Token",
    "dNO",
    true,
    true,
  );
  await mint("frozen", 14, 6, "Demo Frozen Token", "dICE");
  await mint("nft1", 15, 0, "Access Pass #1", "dCAMP");
  await mint("nft2", 16, 0, "Access Pass #2", "dCAMP");
  async function ata(key: string, owner: string) {
    return (
      await findAssociatedTokenPda({
        owner: actors[owner].address,
        mint: address(mints[key].address),
        tokenProgram: address(mints[key].program),
      })
    )[0];
  }
  async function allocate(key: string, owner: string, amount: bigint) {
    const token = await ata(key, owner),
      m = mints[key];
    await tx("opening:" + key + ":" + owner, [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: actors.deployer,
        ata: token,
        owner: actors[owner].address,
        mint: address(m.address),
        tokenProgram: address(m.program),
      }),
      getMintToInstruction(
        {
          mint: address(m.address),
          token,
          mintAuthority: actors.deployer,
          amount,
        },
        { programAddress: address(m.program) },
      ),
    ]);
  }
  for (const [name, amount] of [
    ["alice", 10000000000n],
    ["bob", 5000000000n],
    ["carol", 5000000000n],
  ] as const)
    await allocate("dUSDC", name, amount);
  await allocate("sEWLT", "alice", 2500000000000n);
  await allocate("token2022", "alice", 100000000n);
  await allocate("unsupported", "alice", 1000000n);
  await allocate("frozen", "alice", 1000000n);
  await allocate("nft1", "alice", 1n);
  await allocate("nft2", "bob", 1n);
  // Metadata data codecs come from the pinned official generated client. Only
  // serialized data and validated account addresses cross into Kit 8 messages.
  for (const [key, m] of Object.entries(mints).filter(
    ([, m]) => m.program === TOKEN_PROGRAM_ADDRESS,
  )) {
    const metadata = await pda(m.address),
      data = getCreateMetadataAccountV3InstructionDataEncoder().encode({
        data: {
          name: m.name,
          symbol: m.symbol,
          uri: "http://127.0.0.1:8787/fixtures/access-pass.json",
          sellerFeeBasisPoints: 0,
          creators: null,
          collection: null,
          uses: null,
        },
        isMutable: false,
        collectionDetails: null,
      });
    await tx("metadata:" + key, [
      {
        programAddress: META,
        accounts: [
          { address: metadata, role: AccountRole.WRITABLE },
          { address: address(m.address), role: AccountRole.READONLY },
          {
            address: actors.deployer.address,
            role: AccountRole.READONLY_SIGNER,
          },
          {
            address: actors.deployer.address,
            role: AccountRole.WRITABLE_SIGNER,
          },
          { address: actors.deployer.address, role: AccountRole.READONLY },
          {
            address: address("11111111111111111111111111111111"),
            role: AccountRole.READONLY,
          },
        ],
        data: new Uint8Array(data),
      },
    ]);
    if (key.startsWith("nft")) {
      const edition = await pda(m.address, true);
      await tx("edition:" + key, [
        {
          programAddress: META,
          accounts: [
            { address: edition, role: AccountRole.WRITABLE },
            { address: address(m.address), role: AccountRole.WRITABLE },
            {
              address: actors.deployer.address,
              role: AccountRole.READONLY_SIGNER,
            },
            {
              address: actors.deployer.address,
              role: AccountRole.READONLY_SIGNER,
            },
            {
              address: actors.deployer.address,
              role: AccountRole.WRITABLE_SIGNER,
            },
            { address: metadata, role: AccountRole.WRITABLE },
            { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
            {
              address: address("11111111111111111111111111111111"),
              role: AccountRole.READONLY,
            },
          ],
          data: new Uint8Array(
            getCreateMasterEditionV3InstructionDataEncoder().encode({
              maxSupply: 0n,
            }),
          ),
        },
      ]);
      const actual = await account(edition);
      if (
        !actual ||
        getMasterEditionDecoder().decode(fromBase64(actual.data[0])).maxSupply
          .__option !== "Some"
      )
        throw new Error("NFT master edition is not locked");
      const editionState = getMasterEditionDecoder().decode(
        fromBase64(actual.data[0]),
      );
      if (
        editionState.maxSupply.__option !== "Some" ||
        editionState.maxSupply.value !== 0n
      )
        throw new Error("NFT edition permits additional prints");
    } else
      await tx("revoke-mint:" + key, [
        getSetAuthorityInstruction({
          owned: address(m.address),
          owner: actors.deployer,
          authorityType: 0,
          newAuthority: null,
        }),
      ]);
  }
  await tx(
    "delegate:alice",
    [
      getApproveInstruction({
        source: await ata("dUSDC", "alice"),
        delegate: actors.bob.address,
        owner: actors.alice,
        amount: 25000000n,
      }),
    ],
    [actors.alice],
  );
  await tx("freeze:alice", [
    getFreezeAccountInstruction({
      account: await ata("frozen", "alice"),
      mint: address(mints.frozen.address),
      owner: actors.deployer,
    }),
  ]);
  const carolAta = await ata("sEWLT", "carol");
  await tx(
    "SEED-11-sEWLT",
    [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: actors.alice,
        ata: carolAta,
        owner: actors.carol.address,
        mint: address(mints.sEWLT.address),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
      getTransferCheckedInstruction({
        source: await ata("sEWLT", "alice"),
        mint: address(mints.sEWLT.address),
        destination: carolAta,
        authority: actors.alice,
        amount: 50000000000n,
        decimals: 9,
      }),
    ],
    [actors.alice],
  );
  await tx(
    "SEED-11-SOL",
    [
      getTransferSolInstruction({
        source: actors.alice,
        destination: actors.bob.address,
        amount: 1000000000n,
      }),
    ],
    [actors.alice],
  );
  await tx(
    "SEED-11-dUSDC",
    [
      getTransferCheckedInstruction({
        source: await ata("dUSDC", "alice"),
        mint: address(mints.dUSDC.address),
        destination: await ata("dUSDC", "bob"),
        authority: actors.alice,
        amount: 12345678n,
        decimals: 6,
      }),
    ],
    [actors.alice],
  );
  const freshRecipient = (await signer("carol", 1)).address,
    freshAta = (
      await findAssociatedTokenPda({
        owner: freshRecipient,
        mint: address(mints.dUSDC.address),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
    )[0];
  await tx(
    "SEED-11-fresh-ATA",
    [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: actors.alice,
        ata: freshAta,
        owner: freshRecipient,
        mint: address(mints.dUSDC.address),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
      getTransferCheckedInstruction({
        source: await ata("dUSDC", "alice"),
        mint: address(mints.dUSDC.address),
        destination: freshAta,
        authority: actors.alice,
        amount: 1n,
        decimals: 6,
      }),
    ],
    [actors.alice],
  );
  const aliceNft2 = await ata("nft2", "alice");
  await tx(
    "SEED-12-NFT",
    [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: actors.bob,
        ata: aliceNft2,
        owner: actors.alice.address,
        mint: address(mints.nft2.address),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
      getTransferCheckedInstruction({
        source: await ata("nft2", "bob"),
        mint: address(mints.nft2.address),
        destination: aliceNft2,
        authority: actors.bob,
        amount: 1n,
        decimals: 0,
      }),
    ],
    [actors.bob],
  );
  const assertions = [];
  for (const [key, m] of Object.entries(mints)) {
    const a = await account(m.address);
    if (!a || a.owner !== m.program) throw new Error("Mint identity mismatch");
    const mintData = getMintDecoder().decode(
      fromBase64(a.data[0]).slice(0, 82),
    );
    if (mintData.decimals !== m.decimals)
      throw new Error("Mint precision mismatch");
    if (key.startsWith("nft")) {
      const metadata = await account(await pda(m.address));
      if (
        !metadata ||
        getMetadataDecoder().decode(fromBase64(metadata.data[0])).mint !==
          m.address ||
        mintData.supply !== 1n ||
        mintData.mintAuthority.__option !== "Some" ||
        String(mintData.mintAuthority.value) !== (await pda(m.address, true))
      )
        throw new Error("NFT metadata, supply or authority mismatch");
    }
    assertions.push({
      mint: m.address,
      decimals: mintData.decimals,
      supply: String(mintData.supply),
      mintAuthority:
        mintData.mintAuthority.__option === "None"
          ? null
          : String(mintData.mintAuthority.value),
      state: "passed",
    });
  }
  const finalBalances = [];
  for (const name of ["alice", "bob", "carol", "dana"]) {
    const sol = z
        .object({ value: raw })
        .parse(
          await rpc("getBalance", [
            actors[name].address,
            { commitment: "confirmed" },
          ]),
        ).value,
      tokens: Record<string, string> = {};
    for (const key of Object.keys(mints)) {
      const a = await account(await ata(key, name));
      tokens[key] = a
        ? String(
            getTokenDecoder().decode(fromBase64(a.data[0]).slice(0, 165))
              .amount,
          )
        : "0";
    }
    finalBalances.push({ name, address: actors[name].address, sol, tokens });
  }
  const expectedTokens: Record<string, Record<string, string>> = {
    alice: {
      dUSDC: "9987654321",
      sEWLT: "2450000000000",
      token2022: "100000000",
      unsupported: "1000000",
      frozen: "1000000",
      nft1: "1",
      nft2: "1",
    },
    bob: { dUSDC: "5012345678", nft1: "0", nft2: "0" },
    carol: { dUSDC: "5000000000", sEWLT: "50000000000" },
    dana: { dUSDC: "0", sEWLT: "0", nft1: "0", nft2: "0" },
  };
  const ataRent = BigInt(
    raw.parse(await rpc("getMinimumBalanceForRentExemption", [165])),
  );
  const fees = (id: string) => {
    const fee = journal.stages[id].fee;
    if (fee === null || fee === undefined)
      throw new Error("Missing observed transaction fee: " + id);
    return BigInt(fee);
  };
  const expectedSol = {
    alice:
      99000000000n -
      fees("delegate:alice") -
      fees("SEED-11-sEWLT") -
      fees("SEED-11-SOL") -
      fees("SEED-11-dUSDC") -
      fees("SEED-11-fresh-ATA") -
      2n * ataRent,
    bob: 101000000000n - fees("SEED-12-NFT") - ataRent,
    carol: 100000000000n,
    dana: 0n,
  };
  for (const entry of finalBalances) {
    for (const [key, expected] of Object.entries(expectedTokens[entry.name]))
      if (entry.tokens[key] !== expected)
        throw new Error(
          "Final Solana token balance mismatch: " + entry.name + ":" + key,
        );
    if (
      BigInt(entry.sol) !== expectedSol[entry.name as keyof typeof expectedSol]
    )
      throw new Error("Final SOL balance/fee/rent mismatch: " + entry.name);
  }
  const frozen = await account(await ata("frozen", "alice")),
    delegated = await account(await ata("dUSDC", "alice"));
  if (
    !frozen ||
    getTokenDecoder().decode(fromBase64(frozen.data[0])).state !== 2
  )
    throw new Error("Frozen fixture is not frozen");
  if (!delegated) throw new Error("Missing delegated account");
  const delegate = getTokenDecoder().decode(fromBase64(delegated.data[0]));
  if (
    delegate.delegate.__option !== "Some" ||
    delegate.delegate.value !== actors.bob.address ||
    delegate.delegatedAmount !== 25000000n
  )
    throw new Error("SPL delegate differs from fixture");
  const build = JSON.parse(await readFile("infra/metaplex-build.json", "utf8"));
  const manifest = {
    schemaVersion: 1,
    seedVersion: 1,
    networkId: "solana:local",
    genesisHash,
    observedAt: new Date().toISOString(),
    metadataProgram: {
      ...build,
      loadedExecutable: true,
      binaryHash: createHash("sha256")
        .update(await readFile(".local/programs/token_metadata.so"))
        .digest("hex"),
    },
    identities: Object.fromEntries(
      Object.entries(roots)
        .filter(([name]) => name !== "deployer")
        .map(([name, root]) => [
          name,
          derivePublic(root.secret, "fixture-" + name, {
            family: "solana",
            index: 0,
          }),
        ]),
    ),
    mints,
    stages: journal.stages,
    assertions,
    freshRecipient: {
      address: freshRecipient,
      path: "m/44'/501'/1'/0'",
      tokenAccount: freshAta,
      amount: "1",
    },
    finalBalances,
  };
  solanaManifestSchema.parse(manifest);
  await writeFile(
    isolated
      ? ".local/reports/chains/isolated-solana-manifest.json"
      : ".local/state/seed/solana-manifest.json",
    encode(manifest),
  );
  console.log(
    `Solana: ${Object.keys(journal.stages).length} real stages reconciled; metadata and supply assertions passed.`,
  );
  return manifest;
}
if (process.argv[1]?.endsWith("/seed-solana.ts")) await seedSolana();
