export { decodeExternalSolana, prepareExternalSolana } from "./external";
import { z } from "zod";
import {
  address,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getAddressEncoder,
  getUtf8Encoder,
  type Instruction,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  getMintDecoder,
  getTokenDecoder,
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getRevokeInstruction,
} from "@solana-program/token";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getMintDecoder as getMint2022Decoder,
  getTokenDecoder as getToken2022Decoder,
} from "@solana-program/token-2022";
import { getMetadataDecoder } from "@metaplex-foundation/mpl-token-metadata-kit";
import {
  WalletError,
  assetKey,
  type AccountRef,
  type AssetBalance,
  type Collectible,
  type PreparedOperation,
  type TransactionIntent,
} from "@ewallet/domain";
import { networkById } from "@ewallet/config";
import { nodeRpc } from "@ewallet/config/rpc";
const raw = z.string().regex(/^(0|[1-9][0-9]*)$/);
const encodedAccount = z.object({
  owner: z.string(),
  lamports: raw,
  executable: z.boolean(),
  data: z.tuple([z.string().max(100000), z.literal("base64")]),
});
export const solanaPayloadSchema = z
  .object({
    family: z.literal("solana"),
    external: z.boolean().optional(),
    genesisHash: z.string(),
    unsignedTransaction: z.string().max(5000),
    accountAddress: z.string(),
    blockhash: z.string(),
    lastValidBlockHeight: raw,
    observedSlot: raw,
    rent: raw,
  })
  .strict();
export type SolanaPayload = z.infer<typeof solanaPayloadSchema>;
export function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export function toBase64(value: ReadonlyUint8Array) {
  return btoa(Array.from(value, (b) => String.fromCharCode(b)).join(""));
}
export async function sha256(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function hasExtensions(bytes: Uint8Array) {
  const extensions = getToken2022Decoder().decode(bytes).extensions;
  return (
    extensions.__option === "Some" &&
    extensions.value.some((e) => e.__kind !== "ImmutableOwner")
  );
}
const META = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export class SolanaAdapter {
  readonly profile;
  constructor(
    readonly networkId: string,
    readonly rpc = (method: string, params: unknown[] = []) =>
      nodeRpc(networkId, method, params),
    private localRegistry?: {
      genesisHash: string;
      mints: Array<{
        address: string;
        decimals: number;
        program: string;
        name: string;
        symbol: string;
      }>;
    },
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.profile = networkById(networkId);
    if (this.profile.family !== "solana")
      throw new WalletError("NETWORK", "Select a Solana profile.");
  }
  async identity() {
    const genesis = z.string().parse(await this.rpc("getGenesisHash"));
    if (this.networkId === "solana:devnet" && genesis !== this.profile.identity)
      throw new WalletError(
        "WRONG_NETWORK",
        "RPC genesis differs from Solana Devnet.",
      );
    if (this.networkId === "solana:local" && this.localRegistry) {
      if (genesis !== this.localRegistry.genesisHash)
        throw new WalletError(
          "WRONG_NETWORK",
          "Local Solana registry belongs to another genesis.",
        );
      return genesis;
    }
    if (this.networkId === "solana:local") {
      const response = await this.fetcher("/api/v1/solana/environment", {
        cache: "no-store",
      });
      if (!response.ok)
        throw new WalletError(
          "NEEDS_SEED",
          "Local Solana genesis is not registered. Run its local seeder.",
        );
      const body = z
        .object({ data: z.object({ genesisHash: z.string() }) })
        .parse(await response.json());
      if (genesis !== body.data.genesisHash)
        throw new WalletError(
          "WRONG_NETWORK",
          "Local Solana genesis differs from the seed manifest.",
        );
    }
    return genesis;
  }
  async account(reference: string) {
    address(reference);
    const result = z
      .object({
        context: z.object({ slot: raw }),
        value: encodedAccount.nullable(),
      })
      .parse(
        await this.rpc("getAccountInfo", [
          reference,
          { encoding: "base64", commitment: "confirmed" },
        ]),
      );
    return result;
  }
  async mint(reference: string) {
    const { value, context } = await this.account(reference);
    if (
      !value ||
      value.executable ||
      ![
        String(TOKEN_PROGRAM_ADDRESS),
        String(TOKEN_2022_PROGRAM_ADDRESS),
      ].includes(value.owner)
    )
      throw new WalletError(
        "MINT",
        "Address is not a supported initialized token mint.",
      );
    const bytes = fromBase64(value.data[0]),
      is2022 = value.owner === TOKEN_2022_PROGRAM_ADDRESS;
    const mint = is2022
      ? getMint2022Decoder().decode(bytes)
      : getMintDecoder().decode(bytes);
    if (!mint.isInitialized || mint.decimals > 36)
      throw new WalletError(
        "DECIMALS",
        "Unsupported or uninitialized token mint.",
      );
    const extensionData = is2022
      ? getMint2022Decoder().decode(bytes).extensions
      : null;
    const extensions =
      extensionData?.__option === "Some" ? extensionData.value : [];
    return {
      reference,
      program: address(value.owner),
      mint,
      is2022,
      extensions,
      supported: extensions.length === 0,
      slot: context.slot,
    };
  }
  async tokenAccounts(account: AccountRef) {
    const results = [];
    for (const program of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
      const result = z
        .object({
          context: z.object({ slot: raw }),
          value: z
            .array(z.object({ pubkey: z.string(), account: encodedAccount }))
            .max(200),
        })
        .parse(
          await this.rpc("getTokenAccountsByOwner", [
            account.address,
            { programId: program },
            { encoding: "base64", commitment: "confirmed" },
          ]),
        );
      for (const entry of result.value) {
        if (entry.account.owner !== program)
          throw new WalletError(
            "TOKEN_OWNER",
            "Token program ownership mismatch.",
          );
        const bytes = fromBase64(entry.account.data[0]),
          token =
            program === TOKEN_PROGRAM_ADDRESS
              ? getTokenDecoder().decode(bytes)
              : getToken2022Decoder().decode(bytes);
        if (token.owner !== account.address)
          throw new WalletError(
            "TOKEN_OWNER",
            "Token authority differs from the wallet.",
          );
        const extensionData =
          program === TOKEN_2022_PROGRAM_ADDRESS
            ? getToken2022Decoder().decode(bytes).extensions
            : null;
        const extensions =
          extensionData?.__option === "Some" ? extensionData.value : [];
        results.push({
          reference: entry.pubkey,
          program,
          token,
          slot: result.context.slot,
          supported: extensions.every((e) => e.__kind === "ImmutableOwner"),
        });
      }
    }
    return results;
  }
  async metadata(mint: string) {
    const [pda] = await getProgramDerivedAddress({
      programAddress: address(META),
      seeds: [
        getUtf8Encoder().encode("metadata"),
        getAddressEncoder().encode(address(META)),
        getAddressEncoder().encode(address(mint)),
      ],
    });
    const { value } = await this.account(pda);
    if (!value) return null;
    if (value.owner !== META || value.executable)
      throw new WalletError(
        "NFT_METADATA",
        "Metadata account owner is invalid.",
      );
    try {
      const metadata = getMetadataDecoder().decode(fromBase64(value.data[0]));
      if (String(metadata.mint) !== mint) throw new Error("mint");
      return metadata;
    } catch {
      throw new WalletError(
        "NFT_METADATA",
        "Metadata account could not be validated.",
      );
    }
  }
  async discoverAccounts(accounts: AccountRef[]) {
    await this.identity();
    const queue = [...accounts],
      results: Array<{ account: AccountRef; used: boolean }> = [];
    let slot = "0";
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (queue.length) {
          const account = queue.shift()!,
            balance = z
              .object({ context: z.object({ slot: raw }), value: raw })
              .parse(
                await this.rpc("getBalance", [
                  account.address,
                  { commitment: "confirmed" },
                ]),
              );
          if (BigInt(balance.context.slot) > BigInt(slot))
            slot = balance.context.slot;
          let used = BigInt(balance.value) > 0n;
          if (!used)
            used =
              z
                .array(z.unknown())
                .parse(
                  await this.rpc("getSignaturesForAddress", [
                    account.address,
                    { limit: 1, commitment: "confirmed" },
                  ]),
                ).length > 0;
          if (!used)
            for (const program of [
              TOKEN_PROGRAM_ADDRESS,
              TOKEN_2022_PROGRAM_ADDRESS,
            ])
              if (
                z
                  .object({ value: z.array(z.unknown()) })
                  .parse(
                    await this.rpc("getTokenAccountsByOwner", [
                      account.address,
                      { programId: program },
                      { encoding: "base64", commitment: "confirmed" },
                    ]),
                  ).value.length > 0
              ) {
                used = true;
                break;
              }
          results.push({ account, used });
        }
      }),
    );
    await this.identity();
    return {
      results: results.sort((a, b) => a.account.index - b.account.index),
      height: slot,
      coverage:
        "SOL, address signatures and both token-program account sets at confirmed commitment. Pruned history can limit past usage detection.",
    };
  }
  async registry() {
    if (this.networkId !== "solana:local") return [];
    if (this.localRegistry) {
      await this.identity();
      return this.localRegistry.mints;
    }
    const response = await this.fetcher("/api/v1/solana/registry", {
      cache: "no-store",
    });
    if (!response.ok)
      throw new WalletError(
        "NEEDS_SEED",
        "Local Solana registry is unavailable.",
      );
    const body = z
      .object({
        data: z.object({
          genesisHash: z.string(),
          mints: z.record(
            z.string(),
            z.object({
              address: z.string(),
              decimals: z.number().int().min(0).max(36),
              program: z.string(),
              name: z.string().max(100),
              symbol: z.string().max(30),
            }),
          ),
        }),
      })
      .parse(await response.json());
    if (body.data.genesisHash !== (await this.identity()))
      throw new WalletError(
        "WRONG_NETWORK",
        "Solana registry belongs to another genesis.",
      );
    return Object.values(body.data.mints);
  }
  async portfolio(account: AccountRef) {
    await this.identity();
    const native = z
        .object({ context: z.object({ slot: raw }), value: raw })
        .parse(
          await this.rpc("getBalance", [
            account.address,
            { commitment: "confirmed" },
          ]),
        ),
      observedAt = new Date().toISOString();
    const observation = (slot: string) => ({
      source: "node" as const,
      networkId: this.networkId,
      observedHeight: slot,
      observedAt,
    });
    const registry = await this.registry();
    const balances: AssetBalance[] = [
        {
          asset: {
            networkId: this.networkId,
            standard: "native",
            reference: "native",
          },
          raw: native.value,
          available: native.value,
          reserved: "0",
          decimals: 9,
          observation: observation(native.context.slot),
          symbol: "SOL",
          name: "Solana",
          hidden: false,
          verified: false,
          microUsdRate: null,
          stale: false,
        },
      ],
      collectibles: Collectible[] = [],
      delegates = [];
    for (const accountInfo of await this.tokenAccounts(account)) {
      const m = await this.mint(accountInfo.token.mint),
        metadata = await this.metadata(m.reference),
        standard =
          metadata?.tokenStandard.__option === "Some"
            ? metadata.tokenStandard.value
            : null;
      const nft =
          m.mint.decimals === 0 &&
          m.mint.supply === 1n &&
          [0, 3, 4, 5].includes(standard ?? -1),
        supported =
          m.supported && accountInfo.supported && accountInfo.token.state === 1;
      const registered = registry.find((r) => r.address === m.reference);
      if (
        registered &&
        (registered.decimals !== m.mint.decimals ||
          registered.program !== m.program)
      )
        throw new WalletError(
          "MINT_CHANGED",
          "Registered mint identity changed.",
        );
      const asset = {
        networkId: this.networkId,
        standard: nft
          ? ("solana-nft" as const)
          : m.is2022
            ? ("token2022" as const)
            : ("spl" as const),
        reference: m.reference,
      };
      if (nft && accountInfo.token.amount > 0n)
        collectibles.push({
          id: assetKey(asset),
          asset,
          name: metadata!.name.replace(/\0/g, "").trim().slice(0, 100),
          quantity: String(accountInfo.token.amount),
          metadataStatus:
            [0, 3].includes(standard ?? -1) && !m.is2022
              ? "missing"
              : "unsupported",
          transferable:
            supported && [0, 3].includes(standard ?? -1) && !m.is2022,
          unsupportedReason: !supported
            ? "Token account is frozen or has unsupported extensions."
            : ![0, 3].includes(standard ?? -1) || m.is2022
              ? "Programmable and Token-2022 NFTs are unsupported."
              : undefined,
          image: null,
          owner: account.address,
          observation: observation(accountInfo.slot),
        });
      else
        balances.push({
          asset,
          raw: String(accountInfo.token.amount),
          available: supported ? String(accountInfo.token.amount) : "0",
          reserved: "0",
          decimals: m.mint.decimals,
          observation: observation(accountInfo.slot),
          symbol:
            registered?.symbol ||
            metadata?.symbol.replace(/\0/g, "").trim().slice(0, 30) ||
            m.reference.slice(0, 6),
          name:
            registered?.name ||
            metadata?.name.replace(/\0/g, "").trim().slice(0, 100) ||
            `Unverified ${m.is2022 ? "Token-2022" : "SPL"} mint`,
          hidden: false,
          verified: Boolean(registered),
          microUsdRate: null,
          stale: false,
        });
      if (accountInfo.token.delegate.__option === "Some")
        delegates.push({
          id: accountInfo.reference,
          asset,
          spender: String(accountInfo.token.delegate.value),
          raw: String(accountInfo.token.delegatedAmount),
          symbol:
            registered?.symbol ||
            metadata?.symbol.replace(/\0/g, "").trim().slice(0, 30) ||
            m.reference.slice(0, 6),
          decimals: m.mint.decimals,
        });
    }
    return { balances, collectibles, allowances: delegates, observedAt };
  }
  async prepare(
    intent: TransactionIntent,
    account: AccountRef,
  ): Promise<PreparedOperation> {
    const genesisHash = await this.identity();
    if (
      account.family !== "solana" ||
      intent.accountId !== account.id ||
      intent.networkId !== this.networkId ||
      intent.asset.networkId !== this.networkId
    )
      throw new WalletError(
        "WRONG_NETWORK",
        "Account, asset and network must match.",
      );
    const recipient = address(intent.recipient),
      owner = address(account.address),
      signer = createNoopSigner(owner),
      amount = BigInt(intent.amount),
      instructions: Instruction[] = [],
      warnings: string[] = [];
    let rent = 0n,
      decimals = 9,
      symbol = "SOL",
      decoded = "System Program transfer";
    if (intent.recipient === account.address)
      warnings.push("This recipient is your own account.");
    if (amount === 0n && intent.kind !== "revoke")
      throw new WalletError("AMOUNT", "Amount must be positive.");
    if (intent.kind === "send" && intent.asset.standard === "native") {
      const dest = await this.account(recipient);
      if (
        dest.value &&
        (dest.value.owner !== "11111111111111111111111111111111" ||
          dest.value.executable)
      )
        throw new WalletError(
          "RECIPIENT",
          "SOL transfers support ordinary system accounts only.",
        );
      instructions.push(
        getTransferSolInstruction({
          source: signer,
          destination: recipient,
          amount,
        }),
      );
    } else if (
      ["send", "nft-transfer", "revoke"].includes(intent.kind) &&
      ["spl", "token2022", "solana-nft"].includes(intent.asset.standard)
    ) {
      const mint = await this.mint(intent.asset.reference);
      if (!mint.supported)
        throw new WalletError(
          "UNSUPPORTED_EXTENSION",
          "This Token-2022 mint has extensions that this wallet does not support.",
        );
      if ((intent.asset.standard === "token2022") !== mint.is2022)
        throw new WalletError(
          "TOKEN_PROGRAM",
          "Reviewed token program differs from the mint owner.",
        );
      const candidates = (await this.tokenAccounts(account)).filter(
        (a) =>
          a.token.mint === intent.asset.reference && a.token.amount >= amount,
      );
      const source =
        intent.kind === "revoke"
          ? (candidates.find(
              (a) =>
                a.reference === intent.parameters?.tokenAccount &&
                a.token.delegate.__option === "Some" &&
                a.token.delegate.value === recipient,
            ) ??
            candidates.find(
              (a) =>
                a.token.delegate.__option === "Some" &&
                a.token.delegate.value === recipient,
            ))
          : (candidates.find(
              (a) => a.reference === intent.parameters?.tokenAccount,
            ) ?? candidates[0]);
      if (!source || source.token.state !== 1 || !source.supported)
        throw new WalletError(
          "TOKEN_FROZEN",
          "Token account is missing, frozen or has unsupported extensions.",
        );
      decimals = mint.mint.decimals;
      const meta = await this.metadata(mint.reference);
      symbol =
        meta?.symbol.replace(/\0/g, "").trim().slice(0, 30) ||
        mint.reference.slice(0, 6);
      if (
        meta?.tokenStandard.__option === "Some" &&
        [4, 5].includes(meta.tokenStandard.value)
      )
        throw new WalletError(
          "UNSUPPORTED_NFT",
          "Programmable NFTs are visible but unsupported for signing.",
        );
      if (intent.kind === "nft-transfer") {
        const standard =
          meta?.tokenStandard.__option === "Some"
            ? meta.tokenStandard.value
            : -1;
        if (
          mint.is2022 ||
          mint.mint.decimals !== 0 ||
          mint.mint.supply !== 1n ||
          amount !== 1n ||
          ![0, 3].includes(standard)
        )
          throw new WalletError(
            "UNSUPPORTED_NFT",
            "Only validated standard, nonprogrammable Metaplex NFTs are transferable.",
          );
      }
      if (intent.kind === "revoke") {
        if (
          source.token.delegate.__option !== "Some" ||
          source.token.delegate.value !== recipient
        )
          throw new WalletError(
            "DELEGATE_CHANGED",
            "Delegate differs from the reviewed authorization.",
          );
        instructions.push(
          getRevokeInstruction(
            { source: address(source.reference), owner: signer },
            { programAddress: mint.program },
          ),
        );
        decoded = `Revoke delegate ${recipient} on token account ${source.reference}`;
      } else {
        const [ata] = await findAssociatedTokenPda({
          owner: recipient,
          mint: address(mint.reference),
          tokenProgram: mint.program,
        });
        const dest = await this.account(ata);
        if (!dest.value) {
          rent = BigInt(
            raw.parse(
              await this.rpc("getMinimumBalanceForRentExemption", [
                mint.is2022 ? 170 : 165,
                { commitment: "confirmed" },
              ]),
            ),
          );
          instructions.push(
            getCreateAssociatedTokenIdempotentInstruction({
              payer: signer,
              ata,
              owner: recipient,
              mint: address(mint.reference),
              tokenProgram: mint.program,
            }),
          );
          warnings.push(
            `Create recipient associated token account; rent ${rent} lamports.`,
          );
        } else {
          const token = mint.is2022
            ? getToken2022Decoder().decode(fromBase64(dest.value.data[0]))
            : getTokenDecoder().decode(fromBase64(dest.value.data[0]));
          if (
            dest.value.owner !== mint.program ||
            token.owner !== recipient ||
            token.mint !== mint.reference ||
            token.state !== 1 ||
            (mint.is2022 && hasExtensions(fromBase64(dest.value.data[0])))
          )
            throw new WalletError(
              "ATA_INVALID",
              "Recipient associated token account is invalid, frozen or unsupported.",
            );
        }
        instructions.push(
          getTransferCheckedInstruction(
            {
              source: address(source.reference),
              mint: address(mint.reference),
              destination: ata,
              authority: signer,
              amount,
              decimals,
            },
            { programAddress: mint.program },
          ),
        );
        decoded = `Checked token transfer: ${amount} base units, mint ${mint.reference}, program ${mint.program}, destination ATA ${ata}`;
      }
    } else
      throw new WalletError(
        "UNSUPPORTED_OPERATION",
        "This Solana operation is outside the decoded baseline.",
      );
    instructions.unshift(getSetComputeUnitLimitInstruction({ units: 200000 }));
    const marker = crypto.randomUUID();
    instructions.push({
      programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      data: new TextEncoder().encode("e-wallet:" + marker),
    });
    decoded += `; public request marker ${marker}`;
    const latest = z
      .object({
        context: z.object({ slot: raw }),
        value: z.object({ blockhash: z.string(), lastValidBlockHeight: raw }),
      })
      .parse(
        await this.rpc("getLatestBlockhash", [{ commitment: "confirmed" }]),
      );
    const message = appendTransactionMessageInstructions(
      instructions,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.value.blockhash),
          lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          owner,
          createTransactionMessage({ version: 0 }),
        ),
      ),
    );
    const tx = compileTransaction(message),
      unsignedTransaction = toBase64(getTransactionEncoder().encode(tx));
    if (getTransactionEncoder().encode(tx).length > 1232)
      throw new WalletError(
        "TRANSACTION_SIZE",
        "Transaction exceeds the supported packet size.",
      );
    const feeResponse = z
      .object({ value: raw.nullable() })
      .parse(
        await this.rpc("getFeeForMessage", [
          toBase64(tx.messageBytes),
          { commitment: "confirmed" },
        ]),
      );
    if (feeResponse.value === null)
      throw new WalletError(
        "BLOCKHASH_EXPIRED",
        "Transaction blockhash expired. Request a fresh review.",
      );
    const fee = BigInt(feeResponse.value),
      native = z
        .object({ value: raw })
        .parse(
          await this.rpc("getBalance", [
            account.address,
            { commitment: "confirmed" },
          ]),
        );
    if (
      BigInt(native.value) <
      fee + rent + (intent.asset.standard === "native" ? amount : 0n)
    )
      throw new WalletError(
        "INSUFFICIENT_FUNDS",
        "Keep enough SOL for the transfer, transaction fee and account rent.",
      );
    const simulation = z
      .object({ value: z.object({ err: z.unknown().nullable() }) })
      .parse(
        await this.rpc("simulateTransaction", [
          unsignedTransaction,
          {
            encoding: "base64",
            commitment: "confirmed",
            sigVerify: false,
            replaceRecentBlockhash: false,
          },
        ]),
      );
    if (simulation.value.err !== null)
      throw new WalletError(
        "SIMULATION_FAILED",
        "Solana simulation failed. Check ownership, freeze state, balance and recipient.",
      );
    const now = Date.now(),
      payload: SolanaPayload = {
        family: "solana",
        genesisHash,
        unsignedTransaction,
        accountAddress: account.address,
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: latest.value.lastValidBlockHeight,
        observedSlot: latest.context.slot,
        rent: String(rent),
      },
      expiresAt = now + 30000;
    return {
      id: crypto.randomUUID(),
      intent: structuredClone(intent),
      encodedPayload: JSON.stringify(payload),
      preview: {
        sender: account.address,
        title: intent.kind,
        recipient: intent.recipient,
        amount: intent.amount,
        warnings,
        assetSymbol: symbol,
        decimals,
        decodedOperation: decoded,
      },
      fee: {
        estimated: String(fee + rent),
        maximum: String(fee + rent),
        symbol: "SOL (including ATA rent)",
        decimals: 9,
      },
      createdAt: now,
      expiresAt,
      fingerprint: `${this.networkId}:${account.address}:${latest.value.blockhash}`,
      digest: await sha256(JSON.stringify({ intent, payload, expiresAt })),
      source: "node",
    };
  }
  async revalidate(op: PreparedOperation, account: AccountRef) {
    const payload = solanaPayloadSchema.parse(JSON.parse(op.encodedPayload));
    if (
      (await this.identity()) !== payload.genesisHash ||
      account.address !== payload.accountAddress
    )
      throw new WalletError(
        "WRONG_NETWORK",
        "Reviewed Solana identity changed.",
      );
    if (
      BigInt(
        raw.parse(
          await this.rpc("getBlockHeight", [{ commitment: "confirmed" }]),
        ),
      ) > BigInt(payload.lastValidBlockHeight)
    )
      throw new WalletError(
        "BLOCKHASH_EXPIRED",
        "Blockhash expired. Review a fresh operation.",
      );
    const tx = getTransactionDecoder().decode(
        fromBase64(payload.unsignedTransaction),
      ),
      message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (
      (message.version !== 0 &&
        !(payload.external && message.version === "legacy")) ||
      message.staticAccounts[0] !== account.address ||
      message.header.numSignerAccounts !== 1 ||
      ("addressTableLookups" in message &&
        message.addressTableLookups?.length) ||
      message.lifetimeToken !== payload.blockhash
    )
      throw new WalletError(
        "UNSUPPORTED_MESSAGE",
        "Only completely decoded single-signer messages without lookup tables or durable nonces are supported.",
      );
    if (payload.external) {
      const valid = z
        .object({ value: z.boolean() })
        .parse(
          await this.rpc("isBlockhashValid", [
            payload.blockhash,
            { commitment: "confirmed" },
          ]),
        );
      if (!valid.value)
        throw new WalletError(
          "BLOCKHASH_EXPIRED",
          "The exact dapp blockhash expired.",
        );
    }
    const native = z
      .object({ value: raw })
      .parse(
        await this.rpc("getBalance", [
          account.address,
          { commitment: "confirmed" },
        ]),
      );
    if (
      BigInt(native.value) <
      BigInt(op.fee.maximum) +
        (op.intent.asset.standard === "native" ? BigInt(op.intent.amount) : 0n)
    )
      throw new WalletError(
        "INSUFFICIENT_FUNDS",
        "SOL balance changed after review.",
      );
    const simulation = z
      .object({ value: z.object({ err: z.unknown().nullable() }) })
      .parse(
        await this.rpc("simulateTransaction", [
          payload.unsignedTransaction,
          {
            encoding: "base64",
            commitment: "confirmed",
            sigVerify: false,
            replaceRecentBlockhash: false,
          },
        ]),
      );
    if (simulation.value.err !== null)
      throw new WalletError(
        "SIMULATION_FAILED",
        "State changed after review; request a fresh operation.",
      );
    return payload;
  }
  async broadcast(signed: string) {
    return z.string().parse(
      await this.rpc("sendTransaction", [
        signed,
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 2,
        },
      ]),
    );
  }
  async status(signature: string, lastValidBlockHeight: string) {
    await this.identity();
    const result = z
      .object({
        value: z
          .array(
            z
              .object({
                slot: raw,
                err: z.unknown().nullable(),
                confirmationStatus: z
                  .enum(["processed", "confirmed", "finalized"])
                  .nullable(),
              })
              .nullable(),
          )
          .length(1),
      })
      .parse(
        await this.rpc("getSignatureStatuses", [
          [signature],
          { searchTransactionHistory: true },
        ]),
      );
    const value = result.value[0];
    if (!value) {
      const height = raw.parse(
        await this.rpc("getBlockHeight", [{ commitment: "confirmed" }]),
      );
      return {
        state:
          BigInt(height) > BigInt(lastValidBlockHeight)
            ? ("expired" as const)
            : ("submitted" as const),
        height: null,
        fee: null,
        blockHash: null,
      };
    }
    const tx = z
      .object({ meta: z.object({ fee: raw }).nullable() })
      .nullable()
      .parse(
        await this.rpc("getTransaction", [
          signature,
          {
            encoding: "json",
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          },
        ]),
      );
    return {
      state:
        value.err !== null
          ? ("reverted" as const)
          : value.confirmationStatus === "finalized"
            ? ("finalized" as const)
            : value.confirmationStatus === "confirmed"
              ? ("confirmed" as const)
              : ("included" as const),
      height: value.slot,
      fee: tx?.meta?.fee ?? null,
      blockHash: null,
    };
  }
}
