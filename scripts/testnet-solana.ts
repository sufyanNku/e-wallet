import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { z } from "zod";
import { HDKey } from "micro-key-producer/slip10.js";
import {
  address,
  blockhash,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  signTransaction,
  getTransactionEncoder,
  getSignatureFromTransaction,
  getProgramDerivedAddress,
  getAddressEncoder,
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
  getCreateAssociatedTokenIdempotentInstruction,
  findAssociatedTokenPda,
  getMintToInstruction,
  getTransferCheckedInstruction,
  getApproveInstruction,
  getRevokeInstruction,
  getTokenDecoder,
  getMintDecoder,
} from "@solana-program/token";
import {
  getCreateMetadataAccountV3InstructionDataEncoder,
  getCreateMasterEditionV3InstructionDataEncoder,
  getMetadataDecoder,
} from "@metaplex-foundation/mpl-token-metadata-kit";
import type { NetworkProfile } from "@ewallet/domain";
import { rpcUpstream } from "../services/backend/src/rpc";
import { seedBytes } from "../packages/wallet-core/src/derivation";
import type { VaultSecret } from "../packages/wallet-core/src/vault";
import { fromBase64, toBase64 } from "@ewallet/chain-solana";
const META = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
  SYSTEM = address("11111111111111111111111111111111"),
  raw = z.string().regex(/^[0-9]+$/);
export async function executeTestnetSolana(
  profile: NetworkProfile,
  secret: VaultSecret,
  recipient: string,
) {
  if (profile.id !== "solana:devnet")
    throw new Error("Only Devnet fixtures are allowed");
  const dir = ".local/testnet/solana-devnet";
  await mkdir(dir, { recursive: true });
  const rpc = async (method: string, params: unknown[] = []) => {
    const result = (await rpcUpstream(
      profile.rpcs[0],
      method,
      params,
      undefined,
      true,
    )) as { result?: unknown; error?: unknown };
    if (result.error) throw new Error("Devnet RPC failed: " + method);
    return result.result;
  };
  if ((await rpc("getGenesisHash")) !== profile.identity)
    throw new Error("Wrong Devnet genesis");
  const bytes = seedBytes(secret),
    root = HDKey.fromMasterSeed(bytes),
    children = [
      root.derive("m/44'/501'/0'/0'"),
      root.derive("m/44'/501'/1'/0'"),
    ];
  let alice: KeyPairSigner, bob: KeyPairSigner;
  try {
    alice = await createKeyPairSignerFromPrivateKeyBytes(
      children[0].privateKey,
    );
    bob = await createKeyPairSignerFromPrivateKeyBytes(children[1].privateKey);
  } finally {
    bytes.fill(0);
    root.privateKey.fill(0);
    root.chainCode.fill(0);
    for (const child of children) {
      child.privateKey.fill(0);
      child.chainCode.fill(0);
    }
  }
  if (bob.address !== recipient)
    throw new Error("Recipient derivation changed");
  const mints: Record<string, KeyPairSigner> = {};
  for (const name of ["token", "nft"]) {
    const file = dir + "/" + name + ".key";
    let key: Uint8Array;
    try {
      key = new Uint8Array(await readFile(file));
      if (key.length !== 32) throw new Error("Invalid Devnet mint key");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      key = crypto.getRandomValues(new Uint8Array(32));
      await writeFile(file, key, { mode: 0o600, flag: "wx" });
    }
    try {
      mints[name] = await createKeyPairSignerFromPrivateKeyBytes(key);
    } finally {
      key.fill(0);
    }
  }
  const stageSchema = z
      .object({
        signature: z.string(),
        height: raw,
        state: z.enum(["signed", "confirmed"]),
        fee: raw.optional(),
      })
      .strict(),
    journalSchema = z
      .object({
        schemaVersion: z.literal(1),
        genesisHash: z.string(),
        address: z.string(),
        stages: z.record(z.string(), stageSchema),
      })
      .strict();
  let journal: z.infer<typeof journalSchema> = {
    schemaVersion: 1,
    genesisHash: profile.identity,
    address: alice.address,
    stages: {},
  };
  try {
    journal = journalSchema.parse(
      JSON.parse(await readFile(dir + "/journal.json", "utf8")),
    );
    if (
      journal.genesisHash !== profile.identity ||
      journal.address !== alice.address
    )
      throw new Error("Devnet journal identity changed");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const save = async () => {
    await writeFile(
      dir + "/journal.json.tmp",
      JSON.stringify(journal, null, 2),
    );
    await rename(dir + "/journal.json.tmp", dir + "/journal.json");
  };
  async function tx(
    id: string,
    instructions: Instruction[],
    extra: KeyPairSigner[] = [],
  ) {
    let stage = journal.stages[id];
    if (!stage) {
      const latest = z
          .object({
            value: z.object({
              blockhash: z.string(),
              lastValidBlockHeight: raw,
            }),
          })
          .parse(
            await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]),
          ),
        message = appendTransactionMessageInstructions(
          instructions,
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: blockhash(latest.value.blockhash),
              lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
            },
            setTransactionMessageFeePayer(
              alice.address,
              createTransactionMessage({ version: 0 }),
            ),
          ),
        ),
        signed = await signTransaction(
          [alice, ...extra].map((s) => s.keyPair),
          compileTransaction(message),
        ),
        signature = getSignatureFromTransaction(signed),
        serialized = toBase64(getTransactionEncoder().encode(signed));
      await writeFile(dir + "/" + signature + ".signed", serialized, {
        mode: 0o600,
      });
      stage = {
        signature,
        height: latest.value.lastValidBlockHeight,
        state: "signed",
      };
      journal.stages[id] = stage;
      await save();
    }
    const status = z.object({
      value: z.array(
        z
          .object({
            err: z.unknown().nullable(),
            confirmationStatus: z.string().nullable(),
          })
          .nullable(),
      ),
    });
    let observed = status.parse(
      await rpc("getSignatureStatuses", [
        [stage.signature],
        { searchTransactionHistory: true },
      ]),
    ).value[0];
    if (!observed) {
      const height = raw.parse(
        await rpc("getBlockHeight", [{ commitment: "confirmed" }]),
      );
      if (BigInt(height) > BigInt(stage.height))
        throw new Error("Expired uncertain Devnet stage requires audit: " + id);
      const signed = await readFile(
        dir + "/" + stage.signature + ".signed",
        "utf8",
      );
      try {
        if (
          (await rpc("sendTransaction", [
            signed,
            {
              encoding: "base64",
              skipPreflight: false,
              preflightCommitment: "confirmed",
            },
          ])) !== stage.signature
        )
          throw new Error("Signature changed");
      } catch {
        /* Reconcile the expected signature below, never re-sign. */
      }
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      observed = status.parse(
        await rpc("getSignatureStatuses", [
          [stage.signature],
          { searchTransactionHistory: true },
        ]),
      ).value[0];
      if (observed?.err !== null && observed?.err !== undefined)
        throw new Error("Devnet transaction reverted: " + id);
      if (
        observed &&
        ["confirmed", "finalized"].includes(observed.confirmationStatus ?? "")
      )
        break;
      if (attempt === 59)
        throw new Error("Devnet stage remains uncertain: " + id);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const receipt = z
      .object({ meta: z.object({ fee: raw }) })
      .parse(
        await rpc("getTransaction", [
          stage.signature,
          {
            encoding: "json",
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          },
        ]),
      );
    stage.state = "confirmed";
    stage.fee = receipt.meta.fee;
    await save();
  }
  const rent = BigInt(
      raw.parse(await rpc("getMinimumBalanceForRentExemption", [82])),
    ),
    atas: Record<
      string,
      { alice: ReturnType<typeof address>; bob: ReturnType<typeof address> }
    > = {};
  for (const [name, mint] of Object.entries(mints)) {
    const decimals = name === "token" ? 6 : 0,
      amount = name === "token" ? 10000000n : 1n;
    await tx(
      "mint:create:" + name,
      [
        getCreateAccountInstruction({
          payer: alice,
          newAccount: mint,
          lamports: rent,
          space: 82n,
          programAddress: TOKEN_PROGRAM_ADDRESS,
        }),
        getInitializeMint2Instruction({
          mint: mint.address,
          decimals,
          mintAuthority: alice.address,
          freezeAuthority: null,
        }),
      ],
      [mint],
    );
    const aliceAta = (
        await findAssociatedTokenPda({
          owner: alice.address,
          mint: mint.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
      )[0],
      bobAta = (
        await findAssociatedTokenPda({
          owner: bob.address,
          mint: mint.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
      )[0];
    atas[name] = { alice: aliceAta, bob: bobAta };
    await tx("mint:allocation:" + name, [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: alice,
        ata: aliceAta,
        owner: alice.address,
        mint: mint.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
      getMintToInstruction({
        mint: mint.address,
        token: aliceAta,
        mintAuthority: alice,
        amount,
      }),
    ]);
  }
  const mint = mints.nft.address,
    metadata = (
      await getProgramDerivedAddress({
        programAddress: META,
        seeds: [
          getUtf8Encoder().encode("metadata"),
          getAddressEncoder().encode(META),
          getAddressEncoder().encode(mint),
        ],
      })
    )[0],
    edition = (
      await getProgramDerivedAddress({
        programAddress: META,
        seeds: [
          getUtf8Encoder().encode("metadata"),
          getAddressEncoder().encode(META),
          getAddressEncoder().encode(mint),
          getUtf8Encoder().encode("edition"),
        ],
      })
    )[0],
    metaData = getCreateMetadataAccountV3InstructionDataEncoder().encode({
      data: {
        name: "Access Pass",
        symbol: "dCAMP",
        uri: "https://example.invalid/configured/access-pass.json",
        sellerFeeBasisPoints: 0,
        creators: null,
        collection: null,
        uses: null,
      },
      isMutable: false,
      collectionDetails: null,
    });
  await tx("nft:metadata", [
    {
      programAddress: META,
      accounts: [
        { address: metadata, role: AccountRole.WRITABLE },
        { address: mint, role: AccountRole.READONLY },
        { address: alice.address, role: AccountRole.READONLY_SIGNER },
        { address: alice.address, role: AccountRole.WRITABLE_SIGNER },
        { address: alice.address, role: AccountRole.READONLY },
        { address: SYSTEM, role: AccountRole.READONLY },
      ],
      data: new Uint8Array(metaData),
    },
  ]);
  await tx("nft:edition", [
    {
      programAddress: META,
      accounts: [
        { address: edition, role: AccountRole.WRITABLE },
        { address: mint, role: AccountRole.WRITABLE },
        { address: alice.address, role: AccountRole.READONLY_SIGNER },
        { address: alice.address, role: AccountRole.READONLY_SIGNER },
        { address: alice.address, role: AccountRole.WRITABLE_SIGNER },
        { address: metadata, role: AccountRole.WRITABLE },
        { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: SYSTEM, role: AccountRole.READONLY },
      ],
      data: new Uint8Array(
        getCreateMasterEditionV3InstructionDataEncoder().encode({
          maxSupply: 0n,
        }),
      ),
    },
  ]);
  await tx("native:send", [
    getTransferSolInstruction({
      source: alice,
      destination: bob.address,
      amount: 10000n,
    }),
  ]);
  for (const name of ["token", "nft"])
    await tx("transfer:" + name, [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: alice,
        ata: atas[name].bob,
        owner: bob.address,
        mint: mints[name].address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
      getTransferCheckedInstruction({
        source: atas[name].alice,
        mint: mints[name].address,
        destination: atas[name].bob,
        authority: alice,
        amount: 1n,
        decimals: name === "token" ? 6 : 0,
      }),
    ]);
  await tx("delegate:approve", [
    getApproveInstruction({
      source: atas.token.alice,
      delegate: bob.address,
      owner: alice,
      amount: 1n,
    }),
  ]);
  await tx("delegate:revoke", [
    getRevokeInstruction({ source: atas.token.alice, owner: alice }),
  ]);
  const account = async (key: string) =>
      z
        .object({
          value: z.object({
            owner: z.string(),
            data: z.tuple([z.string(), z.literal("base64")]),
          }),
        })
        .parse(
          await rpc("getAccountInfo", [
            key,
            { encoding: "base64", commitment: "confirmed" },
          ]),
        ).value,
    delegated = await account(atas.token.alice),
    nftAccount = await account(atas.nft.bob),
    nftMint = await account(mint),
    metadataAccount = await account(metadata);
  if (
    getTokenDecoder().decode(fromBase64(delegated.data[0])).delegate
      .__option !== "None" ||
    getTokenDecoder().decode(fromBase64(nftAccount.data[0])).amount !== 1n ||
    getMintDecoder().decode(fromBase64(nftMint.data[0])).supply !== 1n ||
    getMetadataDecoder().decode(fromBase64(metadataAccount.data[0])).mint !==
      mint ||
    metadataAccount.owner !== META
  )
    throw new Error("Devnet final state mismatch");
  return {
    networkId: profile.id,
    source: "public-testnet",
    mints: Object.fromEntries(
      Object.entries(mints).map(([name, m]) => [name, m.address]),
    ),
    metadata,
    stages: journal.stages,
    assertions: {
      nftSupplyOne: true,
      realMetadata: true,
      recipientNft: true,
      delegateRevoked: true,
    },
  };
}
