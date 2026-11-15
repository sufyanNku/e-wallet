import { it, expect } from "vitest";
import {
  address,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  getAddressEncoder,
} from "@solana/kit";
import { getMintEncoder } from "@solana-program/token-2022";
import { SolanaAdapter, fromBase64, toBase64 } from "@ewallet/chain-solana";
import { networkById } from "@ewallet/config";
import {
  importSecret,
  derivePublic,
} from "../../packages/wallet-core/src/derivation";
import { signReviewedSolana } from "../../packages/wallet-core/src/solana-signer";
import { solanaPayloadSchema } from "@ewallet/chain-solana";
const secret = importSecret(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  ),
  account = derivePublic(secret, "vector", { family: "solana", index: 0 }),
  bob = derivePublic(secret, "vector", { family: "solana", index: 1 });
const genesis = networkById("solana:devnet").identity;
it("signs the exact Kit message with the independently verified Solana derivation and preserves amounts beyond JS safe integer range", async () => {
  const huge = "9007199254740993";
  const adapter = new SolanaAdapter("solana:devnet", async (method) => {
    if (method === "getGenesisHash") return genesis;
    if (method === "getAccountInfo")
      return { context: { slot: "42" }, value: null };
    if (method === "getLatestBlockhash")
      return {
        context: { slot: "42" },
        value: {
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: "100",
        },
      };
    if (method === "getFeeForMessage") return { value: "5000" };
    if (method === "getBalance")
      return { context: { slot: "42" }, value: "18446744073709551615" };
    if (method === "simulateTransaction") return { value: { err: null } };
    if (method === "getBlockHeight") return "43";
    throw new Error("Unexpected method " + method);
  });
  const op = await adapter.prepare(
      {
        requestId: crypto.randomUUID(),
        accountId: account.id,
        networkId: "solana:devnet",
        kind: "send",
        recipient: bob.address,
        asset: {
          networkId: "solana:devnet",
          standard: "native",
          reference: "native",
        },
        amount: huge,
      },
      account,
    ),
    payload = solanaPayloadSchema.parse(JSON.parse(op.encodedPayload));
  const reviewed = getTransactionDecoder().decode(
    fromBase64(payload.unsignedTransaction),
  );
  const result = await signReviewedSolana(
      secret,
      account,
      await adapter.revalidate(op, account),
    ),
    signed = getTransactionDecoder().decode(fromBase64(result.signed));
  expect(new Uint8Array(signed.messageBytes)).toEqual(
    new Uint8Array(reviewed.messageBytes),
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(getAddressEncoder().encode(address(account.address))),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      new Uint8Array(Object.values(signed.signatures)[0]!),
      new Uint8Array(signed.messageBytes),
    ),
  ).toBe(true);
  const message = getCompiledTransactionMessageDecoder().decode(
    signed.messageBytes,
  );
  expect(message.version).toBe(0);
  expect(message.header.numSignerAccounts).toBe(1);
  expect(op.preview.amount).toBe(huge);
  expect(op.fee.maximum).toBe("5000");
  await expect(signReviewedSolana(secret, bob, payload)).rejects.toThrow(
    "selected account",
  );
});
it("blocks wrong genesis before any balance lookup or signature", async () => {
  const methods: string[] = [];
  const adapter = new SolanaAdapter("solana:devnet", async (method) => {
    methods.push(method);
    return "11111111111111111111111111111111";
  });
  await expect(adapter.identity()).rejects.toThrow("genesis");
  expect(methods).toEqual(["getGenesisHash"]);
});
it("decodes extension-free Token-2022 u64 supply and refuses a nontransferable extension set", async () => {
  const program = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    mint = account.address;
  for (const extensions of [[], [{ __kind: "NonTransferable" as const }]]) {
    const bytes = getMintEncoder().encode({
      mintAuthority: null,
      supply: 18446744073709551615n,
      decimals: 6,
      isInitialized: true,
      freezeAuthority: null,
      extensions,
    });
    const adapter = new SolanaAdapter("solana:devnet", async () => ({
      context: { slot: "1" },
      value: {
        owner: program,
        lamports: "1000000",
        executable: false,
        data: [toBase64(bytes), "base64"],
      },
    }));
    const actual = await adapter.mint(mint);
    expect(actual.mint.supply).toBe(18446744073709551615n);
    expect(actual.supported).toBe(extensions.length === 0);
  }
});
