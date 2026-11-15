import {
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { HDKey as EdHDKey } from "micro-key-producer/slip10.js";
import { base58 } from "@scure/base";
import { computeAddress, hexlify } from "ethers";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { WalletError, type AccountRef } from "@ewallet/domain";
import { hex, unhex, type VaultSecret } from "./vault";
bitcoin.initEccLib(ecc);
export type DerivationSpec = {
  family: AccountRef["family"];
  index: number;
  bitcoinType?: "p2wpkh" | "p2tr";
  change?: 0 | 1;
  addressIndex?: number;
  name?: string;
};
export function createSecret(passphrase = ""): VaultSecret {
  const entropy = crypto.getRandomValues(new Uint8Array(32));
  try {
    return {
      entropyHex: hex(entropy),
      passphrase: passphrase.normalize("NFKD"),
      derivationVersion: 1,
    };
  } finally {
    entropy.fill(0);
  }
}
export function importSecret(mnemonic: string, passphrase = ""): VaultSecret {
  const normalized = mnemonic.normalize("NFKD").trim().split(/\s+/).join(" ");
  if (
    ![12, 24].includes(normalized.split(" ").length) ||
    !validateMnemonic(normalized, wordlist)
  )
    throw new WalletError(
      "MNEMONIC_INVALID",
      "Enter a valid 12- or 24-word English recovery phrase with a correct checksum.",
    );
  const entropy = mnemonicToEntropy(normalized, wordlist);
  try {
    return {
      entropyHex: hex(entropy),
      passphrase: passphrase.normalize("NFKD"),
      derivationVersion: 1,
    };
  } finally {
    entropy.fill(0);
  }
}
export function recoveryWords(secret: VaultSecret) {
  const entropy = unhex(secret.entropyHex);
  try {
    return entropyToMnemonic(entropy, wordlist).split(" ");
  } finally {
    entropy.fill(0);
  }
}
export function seedBytes(secret: VaultSecret) {
  return mnemonicToSeedSync(recoveryWords(secret).join(" "), secret.passphrase);
}
export function pathFor(spec: DerivationSpec) {
  if (!Number.isInteger(spec.index) || spec.index < 0 || spec.index > 999)
    throw new WalletError("DERIVATION", "Unsupported account index.");
  if (spec.family === "evm") return `m/44'/60'/0'/0/${spec.index}`;
  if (spec.family === "solana") return `m/44'/501'/${spec.index}'/0'`;
  const change = spec.change ?? 0,
    addressIndex = spec.addressIndex ?? 0;
  if (
    ![0, 1].includes(change) ||
    !Number.isInteger(addressIndex) ||
    addressIndex < 0 ||
    addressIndex > 10000
  )
    throw new WalletError("DERIVATION", "Unsupported Bitcoin discovery index.");
  return `m/${spec.bitcoinType === "p2tr" ? 86 : 84}'/1'/${spec.index}'/${change}/${addressIndex}`;
}
export function derivePublic(
  secret: VaultSecret,
  walletId: string,
  spec: DerivationSpec,
): AccountRef {
  const path = pathFor(spec),
    seed = seedBytes(secret);
  let address: string;
  try {
    if (spec.family === "solana") {
      const root = EdHDKey.fromMasterSeed(seed),
        child = root.derive(path);
      try {
        address = base58.encode(child.publicKeyRaw);
      } finally {
        root.privateKey.fill(0);
        root.chainCode.fill(0);
        child.privateKey.fill(0);
        child.chainCode.fill(0);
      }
    } else {
      const root = HDKey.fromMasterSeed(seed),
        child = root.derive(path);
      try {
        if (!child.publicKey) throw new Error("Missing public key");
        address =
          spec.family === "evm"
            ? computeAddress(hexlify(child.publicKey))
            : spec.bitcoinType === "p2tr"
              ? bitcoin.payments.p2tr({
                  internalPubkey: child.publicKey.slice(1, 33),
                  network: bitcoin.networks.regtest,
                }).address!
              : bitcoin.payments.p2wpkh({
                  pubkey: child.publicKey,
                  network: bitcoin.networks.regtest,
                }).address!;
      } finally {
        root.wipePrivateData();
        child.wipePrivateData();
      }
    }
    return {
      id: `${walletId}:${spec.family}:${path}`,
      rootWalletId: walletId,
      family: spec.family,
      address,
      path,
      index: spec.index,
      name: spec.name ?? `Account ${spec.index + 1}`,
    };
  } finally {
    seed.fill(0);
  }
}
export function initialAccounts(secret: VaultSecret, walletId: string) {
  return [
    derivePublic(secret, walletId, { family: "evm", index: 0 }),
    derivePublic(secret, walletId, { family: "solana", index: 0 }),
    derivePublic(secret, walletId, {
      family: "bitcoin",
      index: 0,
      bitcoinType: "p2wpkh",
      name: "Bitcoin SegWit",
    }),
    derivePublic(secret, walletId, {
      family: "bitcoin",
      index: 0,
      bitcoinType: "p2tr",
      name: "Bitcoin Taproot",
    }),
  ];
}
export function specFromAccount(account: AccountRef): DerivationSpec {
  const evm = account.path.match(/^m\/44'\/60'\/0'\/0\/(\d+)$/),
    solana = account.path.match(/^m\/44'\/501'\/(\d+)'\/0'$/),
    btc = account.path.match(/^m\/(84|86)'\/1'\/(\d+)'\/([01])\/(\d+)$/);
  if (account.family === "evm" && evm)
    return { family: "evm", index: Number(evm[1]), name: account.name };
  if (account.family === "solana" && solana)
    return { family: "solana", index: Number(solana[1]), name: account.name };
  if (account.family === "bitcoin" && btc)
    return {
      family: "bitcoin",
      index: Number(btc[2]),
      bitcoinType: btc[1] === "86" ? "p2tr" : "p2wpkh",
      change: Number(btc[3]) as 0 | 1,
      addressIndex: Number(btc[4]),
      name: account.name,
    };
  throw new WalletError(
    "DERIVATION",
    "Backup contains an unsupported derivation path.",
  );
}

export function bitcoinPublicWatch(secret: VaultSecret, account: AccountRef) {
  const spec = specFromAccount(account);
  if (spec.family !== "bitcoin")
    throw new WalletError("DERIVATION", "Select a Bitcoin account.");
  const purpose = spec.bitcoinType === "p2tr" ? (86 as const) : (84 as const),
    seed = seedBytes(secret),
    root = HDKey.fromMasterSeed(seed, {
      private: 0x04358394,
      public: 0x043587cf,
    }),
    node = root.derive(`m/${purpose}'/1'/${account.index}'`);
  try {
    return {
      purpose,
      accountIndex: account.index,
      rootFingerprint: root.fingerprint.toString(16).padStart(8, "0"),
      xpub: node.publicExtendedKey,
    };
  } finally {
    seed.fill(0);
    root.wipePrivateData();
    node.wipePrivateData();
  }
}
