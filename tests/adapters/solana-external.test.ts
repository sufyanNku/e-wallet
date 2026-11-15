import { it, expect } from "vitest";
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  getTransactionDecoder,
  address,
  blockhash,
  createNoopSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  SolanaAdapter,
  prepareExternalSolana,
  decodeExternalSolana,
  toBase64,
  fromBase64,
  solanaPayloadSchema,
} from "@ewallet/chain-solana";
import {
  importSecret,
  derivePublic,
} from "../../packages/wallet-core/src/derivation";
import { signReviewedSolana } from "../../packages/wallet-core/src/solana-signer";
import { networkById } from "@ewallet/config";
const secret = importSecret(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  ),
  alice = derivePublic(secret, "vector", { family: "solana", index: 0 }),
  bob = derivePublic(secret, "vector", { family: "solana", index: 1 }),
  genesis = networkById("solana:devnet").identity;
function transaction(version: "legacy" | 0) {
  const message = appendTransactionMessageInstructions(
    [
      getTransferSolInstruction({
        source: createNoopSigner(address(alice.address)),
        destination: address(bob.address),
        amount: 12345n,
      }),
    ],
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash("11111111111111111111111111111111"),
        lastValidBlockHeight: 100n,
      },
      setTransactionMessageFeePayer(
        address(alice.address),
        createTransactionMessage({ version }),
      ),
    ),
  );
  return toBase64(getTransactionEncoder().encode(compileTransaction(message)));
}
it.each(["legacy", 0] as const)(
  "signs exact external %s System message; controlled expired blockhash fixture refuses revalidation",
  async (version) => {
    let valid = true;
    const adapter = new SolanaAdapter("solana:devnet", async (method) => {
        if (method === "getGenesisHash") return genesis;
        if (method === "isBlockhashValid")
          return { context: { slot: "42" }, value: valid };
        if (method === "getFeeForMessage") return { value: "5000" };
        if (method === "getBalance") return { value: "999999999" };
        if (method === "simulateTransaction") return { value: { err: null } };
        if (method === "getBlockHeight") return "40";
        throw new Error("Unexpected method " + method);
      }),
      encoded = transaction(version),
      op = await prepareExternalSolana(
        adapter,
        encoded,
        alice,
        "https://example.test",
        crypto.randomUUID(),
      );
    expect(op.intent.amount).toBe("12345");
    const signed = await signReviewedSolana(
      secret,
      alice,
      await adapter.revalidate(op, alice),
    );
    expect(
      getTransactionDecoder().decode(fromBase64(signed.signed)).messageBytes,
    ).toEqual(getTransactionDecoder().decode(fromBase64(encoded)).messageBytes);
    expect(
      solanaPayloadSchema.parse(JSON.parse(op.encodedPayload))
        .unsignedTransaction,
    ).toBe(encoded);
    valid = false;
    await expect(adapter.revalidate(op, alice)).rejects.toThrow("expired");
    await expect(
      prepareExternalSolana(
        adapter,
        encoded,
        alice,
        "https://example.test",
        crypto.randomUUID(),
      ),
    ).rejects.toThrow("expired");
    expect(() => decodeExternalSolana(encoded, bob)).toThrow("single-payer");
  },
);
