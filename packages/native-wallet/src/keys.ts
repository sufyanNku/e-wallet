import {
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { p2wpkh, p2tr, TEST_NETWORK } from "@scure/btc-signer";
import { computeAddress } from "ethers";
import type { NativeSecret, EntropySource } from "./vault";
export type MobileAccount = {
  id: string;
  family: "evm" | "solana" | "bitcoin";
  index: number;
  name: string;
  address: string;
  path: string;
  bitcoinType?: "p2wpkh" | "p2tr";
};
export function nativeWords(secret: NativeSecret) {
  const bytes = hexToBytes(secret.entropy);
  try {
    return entropyToMnemonic(bytes, wordlist).split(" ");
  } finally {
    bytes.fill(0);
  }
}
export function nativeImport(words: string, passphrase = ""): NativeSecret {
  const phrase = words.normalize("NFKD").trim().split(/\s+/).join(" ");
  if (
    ![12, 24].includes(phrase.split(" ").length) ||
    !validateMnemonic(phrase, wordlist)
  )
    throw new Error("Enter a valid 12- or 24-word English recovery phrase.");
  const bytes = mnemonicToEntropy(phrase, wordlist);
  try {
    return {
      entropy: bytesToHex(bytes),
      passphrase: passphrase.normalize("NFKD"),
    };
  } finally {
    bytes.fill(0);
  }
}
export function nativeCreate(random: EntropySource): NativeSecret {
  const bytes = random(32);
  try {
    return { entropy: bytesToHex(bytes), passphrase: "" };
  } finally {
    bytes.fill(0);
  }
}
export function nativePath(
  family: MobileAccount["family"],
  index: number,
  bitcoinType = "p2wpkh",
) {
  if (!Number.isInteger(index) || index < 0 || index > 999)
    throw new Error("Unsupported account index.");
  return family === "evm"
    ? `m/44'/60'/0'/0/${index}`
    : family === "solana"
      ? `m/44'/501'/${index}'/0'`
      : `m/${bitcoinType === "p2tr" ? 86 : 84}'/1'/${index}'/0/0`;
}
export function nativePrivate(
  secret: NativeSecret,
  account: Pick<MobileAccount, "family" | "index" | "bitcoinType">,
  change: 0 | 1 = 0,
  addressIndex = 0,
) {
  const seed = mnemonicToSeedSync(
      nativeWords(secret).join(" "),
      secret.passphrase,
    ),
    path =
      account.family === "bitcoin"
        ? nativePath(
            account.family,
            account.index,
            account.bitcoinType,
          ).replace(/0\/0$/, `${change}/${addressIndex}`)
        : nativePath(account.family, account.index, account.bitcoinType);
  if (
    !Number.isInteger(addressIndex) ||
    addressIndex < 0 ||
    addressIndex > 999 ||
    ![0, 1].includes(change)
  )
    throw new Error("Address outside supported range.");
  try {
    if (account.family !== "solana") {
      const root = HDKey.fromMasterSeed(seed);
      try {
        const child = root.derive(path);
        try {
          if (!child.privateKey)
            throw new Error("Private derivation unavailable");
          return new Uint8Array(child.privateKey);
        } finally {
          child.wipePrivateData();
        }
      } finally {
        root.wipePrivateData();
      }
    }
    let digest = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
    try {
      for (const part of path.split("/").slice(1)) {
        const index = Number(part.slice(0, -1)) + 0x80000000,
          data = new Uint8Array(37);
        data.set(digest.slice(0, 32), 1);
        new DataView(data.buffer).setUint32(33, index, false);
        const next = hmac(sha512, digest.slice(32), data);
        digest.fill(0);
        data.fill(0);
        digest = next;
      }
      return digest.slice(0, 32);
    } finally {
      digest.fill(0);
    }
  } finally {
    seed.fill(0);
  }
}
export function nativeAccount(
  secret: NativeSecret,
  family: MobileAccount["family"],
  index = 0,
  bitcoinType: "p2wpkh" | "p2tr" = "p2wpkh",
): MobileAccount {
  const privateKey = nativePrivate(secret, { family, index, bitcoinType });
  try {
    const path = nativePath(family, index, bitcoinType);
    let address: string;
    if (family === "evm")
      address = computeAddress("0x" + bytesToHex(privateKey));
    else if (family === "solana")
      address = base58.encode(ed25519.getPublicKey(privateKey));
    else {
      const publicKey = secp256k1.getPublicKey(privateKey, true);
      address = (
        bitcoinType === "p2tr"
          ? p2tr(publicKey.slice(1), undefined, {
              ...TEST_NETWORK,
              bech32: "bcrt",
            })
          : p2wpkh(publicKey, { ...TEST_NETWORK, bech32: "bcrt" })
      ).address!;
    }
    return {
      id:
        family + ":" + index + (family === "bitcoin" ? ":" + bitcoinType : ""),
      family,
      index,
      name: "Account " + (index + 1),
      address,
      path,
      ...(family === "bitcoin" ? { bitcoinType } : {}),
    };
  } finally {
    privateKey.fill(0);
  }
}
