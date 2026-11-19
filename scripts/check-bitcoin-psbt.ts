import "./report-paths.ts";
import { readFile, writeFile } from "node:fs/promises";
import { roots } from "./seed-evm";
import {
  derivePublic,
  bitcoinPublicWatch,
} from "../packages/wallet-core/src/derivation";
import {
  bitcoinRpc,
  bitcoinIdentity,
} from "../services/backend/src/bitcoin-rpc";
import {
  deriveWatchAddress,
  selectCoins,
  buildPsbt,
  bitcoinPayloadSchema,
  satoshis,
  type BitcoinUtxo,
} from "@ewallet/chain-bitcoin";
import { signReviewedBitcoin } from "../packages/wallet-core/src/bitcoin-signer";
await bitcoinIdentity();
const manifest = JSON.parse(
    await readFile(".local/state/seed/bitcoin-manifest.json", "utf8"),
  ),
  proofs = [];
for (const type of ["p2wpkh", "p2tr"] as const) {
  const account = derivePublic(roots.alice.secret, "fixture-alice", {
      family: "bitcoin",
      index: 0,
      bitcoinType: type,
    }),
    watch = bitcoinPublicWatch(roots.alice.secret, account),
    recipient = derivePublic(roots.bob.secret, "fixture-bob", {
      family: "bitcoin",
      index: 0,
      bitcoinType: "p2wpkh",
    }).address;
  const row = manifest.finalBalances.find(
      (r: { name: string; purpose: number }) =>
        r.name === "alice" && r.purpose === watch.purpose,
    ),
    utxos: BitcoinUtxo[] = [];
  for (const item of row.utxos) {
    const derived = deriveWatchAddress(watch, 0, 0);
    utxos.push({
      txid: item.txid,
      vout: Number(item.vout),
      value: satoshis(item.amount),
      scriptHex: item.scriptPubKey,
      confirmations: item.confirmations,
      address: derived.address,
      path: derived.path,
      change: 0,
      addressIndex: 0,
      rawTransaction: (await bitcoinRpc("getrawtransaction", [
        item.txid,
        false,
      ])) as string,
    });
  }
  const selection = selectCoins(
      utxos,
      1000000n,
      recipient,
      deriveWatchAddress(watch, 1, 0).address,
      watch.purpose,
      2n,
    ),
    payload = bitcoinPayloadSchema.parse({
      family: "bitcoin",
      genesisHash: manifest.genesisHash,
      ledgerFingerprint: manifest.fundingEpoch,
      watch,
      watchId: "0".repeat(64),
      psbt: buildPsbt(watch, selection, recipient, 0).toBase64(),
      inputs: selection.inputs,
      recipient,
      amount: "1000000",
      change: String(selection.change),
      changeIndex: 0,
      fee: String(selection.fee),
      feeRate: "2",
      estimatedVbytes: String(selection.estimatedVbytes),
    }),
    signed = signReviewedBitcoin(roots.alice.secret, account, payload);
  const result = (await bitcoinRpc("testmempoolaccept", [
    [signed.signed],
  ])) as Array<{ allowed: boolean; "reject-reason"?: string }>;
  if (result[0]?.allowed !== true)
    throw new Error(
      "Core rejected " + type + " PSBT: " + result[0]?.["reject-reason"],
    );
  proofs.push({
    type,
    txid: signed.txid,
    fee: payload.fee,
    virtualSize: signed.virtualSize,
    change: payload.change,
    changePath: deriveWatchAddress(watch, 1, 0).path,
    coreMempoolAccept: true,
    broadcast: false,
  });
}
await writeFile(
  ".local/reports/chains/bitcoin-psbt-proof.json",
  JSON.stringify(
    { networkId: "bitcoin:regtest", source: "node", proofs },
    null,
    2,
  ),
);
console.log(
  "Both P2WPKH and tweaked P2TR signatures accepted by Bitcoin Core testmempoolaccept.",
);
