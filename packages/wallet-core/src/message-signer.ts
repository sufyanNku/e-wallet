import { HDKey } from "@scure/bip32";
import { HDKey as EdHDKey } from "micro-key-producer/slip10.js";
import {
  Wallet,
  getAddress,
  getBytes,
  hexlify,
  TypedDataEncoder,
  type TypedDataDomain,
} from "ethers";
import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
} from "@solana/kit";
import { z } from "zod";
import {
  WalletError,
  type AccountRef,
  type MessageReview,
} from "@ewallet/domain";
import { networkById } from "@ewallet/config";
import { seedBytes, pathFor } from "./derivation";
import type { VaultSecret } from "./vault";
export type MessagePayload = {
  method: MessageReview["method"];
  messageHex?: string;
  typed?: {
    domain: TypedDataDomain;
    types: Record<string, Array<{ name: string; type: string }>>;
    value: Record<string, unknown>;
  };
};
const field = z
  .object({
    name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
    type: z.string().max(100),
  })
  .strict();
function validateTyped(input: unknown, networkId: string) {
  const serialized = typeof input === "string" ? input : JSON.stringify(input);
  if (new TextEncoder().encode(serialized).length > 16384)
    throw new WalletError("MESSAGE_SIZE", "Messages are limited to 16 KiB.");
  const data = z
    .object({
      domain: z
        .object({
          name: z.string().max(100).optional(),
          version: z.string().max(100).optional(),
          chainId: z.union([z.string(), z.number().int().safe()]),
          verifyingContract: z.string().optional(),
          salt: z.string().optional(),
        })
        .strict(),
      types: z.record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
        z.array(field).min(1).max(30),
      ),
      primaryType: z.string(),
      message: z.record(z.string(), z.unknown()),
    })
    .strict()
    .parse(JSON.parse(serialized));
  if (
    Object.keys(data.types).length > 20 ||
    BigInt(data.domain.chainId) !== BigInt(networkById(networkId).identity)
  )
    throw new WalletError(
      "WRONG_NETWORK",
      "Typed-data domain chain differs from the selected EVM chain.",
    );
  const types = { ...data.types };
  delete types.EIP712Domain;
  const check = (type: string, value: unknown, depth = 0): void => {
    if (depth > 8)
      throw new WalletError(
        "TYPED_DATA",
        "Typed data exceeds the supported nesting depth.",
      );
    const array = type.match(/^(.*)\[([0-9]*)\]$/);
    if (array) {
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        (array[2] && value.length !== Number(array[2]))
      )
        throw new WalletError("TYPED_DATA", "Invalid typed-data array.");
      for (const item of value) check(array[1], item, depth + 1);
      return;
    }
    if (types[type]) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new WalletError("TYPED_DATA", "Invalid typed-data structure.");
      const fields = types[type],
        names = new Set(fields.map((f) => f.name));
      if (
        names.size !== fields.length ||
        Object.keys(value).some((key) => !names.has(key)) ||
        fields.some(
          (f) =>
            !Object.hasOwn(value, f.name) ||
            ["__proto__", "constructor", "prototype"].includes(f.name),
        )
      )
        throw new WalletError(
          "TYPED_DATA",
          "Typed-data fields must match the signed type exactly.",
        );
      for (const f of fields)
        check(f.type, (value as Record<string, unknown>)[f.name], depth + 1);
      return;
    }
    if (
      (type === "bool" && typeof value !== "boolean") ||
      (type === "string" && typeof value !== "string") ||
      (type === "address" && typeof value !== "string") ||
      (/^bytes/.test(type) &&
        (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)))
    )
      throw new WalletError(
        "TYPED_DATA",
        "Primitive values must match their declared signed type.",
      );
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw new WalletError(
        "TYPED_DATA",
        "Represent large typed integers as decimal strings.",
      );
    if (
      !/^(address|bool|string|bytes([1-9]|[12][0-9]|3[0-2])?|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)$/.test(
        type,
      )
    )
      throw new WalletError("TYPED_DATA", "Unsupported typed-data primitive.");
  };
  const encoder = TypedDataEncoder.from(types);
  if (encoder.primaryType !== data.primaryType)
    throw new WalletError(
      "TYPED_DATA",
      "The declared primary type differs from the signed structure.",
    );
  check(data.primaryType, data.message);
  const domain: TypedDataDomain = {
    ...data.domain,
    chainId: String(BigInt(data.domain.chainId)),
    ...(data.domain.verifyingContract
      ? { verifyingContract: getAddress(data.domain.verifyingContract) }
      : {}),
  };
  TypedDataEncoder.hash(domain, types, data.message);
  const normalized = TypedDataEncoder.getPayload(domain, types, data.message);
  if (
    data.types.EIP712Domain &&
    JSON.stringify(data.types.EIP712Domain) !==
      JSON.stringify(normalized.types.EIP712Domain)
  )
    throw new WalletError(
      "TYPED_DATA",
      "The supplied domain type differs from its signed fields.",
    );
  return {
    domain,
    types,
    value: data.message,
    display: JSON.stringify(normalized, null, 2),
    byteLength: new TextEncoder().encode(serialized).length,
  };
}
export function prepareMessagePayload(
  method: MessageReview["method"],
  params: unknown[],
  account: AccountRef,
  networkId: string,
) {
  if (method === "eth_signTypedData_v4") {
    if (getAddress(z.string().parse(params[0])) !== getAddress(account.address))
      throw new WalletError(
        "SIGNER",
        "Requested signer differs from the authorized account.",
      );
    const typed = validateTyped(params[1], networkId);
    return {
      payload: {
        method,
        typed: { domain: typed.domain, types: typed.types, value: typed.value },
      } as MessagePayload,
      displayText: typed.display,
      encoding: "eip712" as const,
      byteLength: typed.byteLength,
      domain: {
        name: typed.domain.name ?? null,
        version: typed.domain.version ?? null,
        chainId: String(typed.domain.chainId),
        verifyingContract: typed.domain.verifyingContract ?? null,
      },
    };
  }
  let messageHex: string;
  if (method === "personal_sign") {
    messageHex = z
      .string()
      .regex(/^0x(?:[0-9a-f]{2})*$/i)
      .parse(params[0]);
    if (getAddress(z.string().parse(params[1])) !== getAddress(account.address))
      throw new WalletError(
        "SIGNER",
        "Requested signer differs from the authorized account.",
      );
  } else {
    const input = z
      .object({
        messageHex: z.string().regex(/^0x(?:[0-9a-f]{2})*$/i),
        account: z.string(),
      })
      .strict()
      .parse(params[0]);
    if (input.account !== account.address)
      throw new WalletError(
        "SIGNER",
        "Requested Solana signer differs from the authorized account.",
      );
    messageHex = input.messageHex;
  }
  const bytes = getBytes(messageHex);
  if (bytes.length > 16384)
    throw new WalletError("MESSAGE_SIZE", "Messages are limited to 16 KiB.");
  let displayText = messageHex,
    encoding: "utf8" | "hex" = "hex";
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      !Array.from(decoded).some((c) => {
        const n = c.charCodeAt(0);
        return (n < 32 && ![9, 10, 13].includes(n)) || n === 127;
      })
    ) {
      displayText = decoded;
      encoding = "utf8";
    }
  } catch {
    /* Binary messages remain an explicit hexadecimal preview. */
  }
  return {
    payload: { method, messageHex } as MessagePayload,
    displayText,
    encoding,
    byteLength: bytes.length,
    domain: null,
  };
}
export async function signReviewedMessage(
  secret: VaultSecret,
  account: AccountRef,
  payload: MessagePayload,
) {
  const seed = seedBytes(secret);
  try {
    if (account.family === "evm") {
      if (account.path !== pathFor({ family: "evm", index: account.index }))
        throw new WalletError("DERIVATION", "Unsupported message signer path.");
      const root = HDKey.fromMasterSeed(seed),
        child = root.derive(account.path);
      try {
        if (!child.privateKey)
          throw new WalletError("SIGNER", "Unable to derive EVM signer.");
        const signer = new Wallet(hexlify(child.privateKey));
        if (getAddress(signer.address) !== getAddress(account.address))
          throw new WalletError("SIGNER", "Derived EVM address differs.");
        return payload.method === "eth_signTypedData_v4" && payload.typed
          ? await signer.signTypedData(
              payload.typed.domain,
              payload.typed.types,
              payload.typed.value,
            )
          : payload.method === "personal_sign" &&
              payload.messageHex !== undefined
            ? await signer.signMessage(getBytes(payload.messageHex))
            : (() => {
                throw new WalletError(
                  "UNSUPPORTED_METHOD",
                  "Wrong message family.",
                );
              })();
      } finally {
        root.wipePrivateData();
        child.wipePrivateData();
      }
    }
    if (
      account.family === "solana" &&
      payload.method === "solana:signMessage" &&
      payload.messageHex !== undefined
    ) {
      if (account.path !== pathFor({ family: "solana", index: account.index }))
        throw new WalletError("DERIVATION", "Unsupported Solana signer path.");
      const root = EdHDKey.fromMasterSeed(seed),
        child = root.derive(account.path);
      try {
        const pair = await createKeyPairFromPrivateKeyBytes(child.privateKey);
        if ((await getAddressFromPublicKey(pair.publicKey)) !== account.address)
          throw new WalletError("SIGNER", "Derived Solana address differs.");
        return hexlify(
          new Uint8Array(
            await crypto.subtle.sign(
              "Ed25519",
              pair.privateKey,
              new Uint8Array(getBytes(payload.messageHex)),
            ),
          ),
        );
      } finally {
        root.privateKey.fill(0);
        root.chainCode.fill(0);
        child.privateKey.fill(0);
        child.chainCode.fill(0);
      }
    }
    throw new WalletError(
      "UNSUPPORTED_METHOD",
      "This account has no supported message-signing method.",
    );
  } finally {
    seed.fill(0);
  }
}
