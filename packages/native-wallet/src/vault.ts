import { gcm } from "@noble/ciphers/aes.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
export type DeviceStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};
export type EntropySource = (length: number) => Uint8Array;
const envelopeSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-f0-9]{32}$/),
    revision: z.number().int().min(1),
    iterations: z.literal(600000),
    salt: z.string().regex(/^[a-f0-9]{32}$/),
    nonce: z.string().regex(/^[a-f0-9]{24}$/),
    ciphertext: z.string().regex(/^[a-f0-9]{32,4096}$/),
  })
  .strict();
export const nativeSecretSchema = z
  .object({
    entropy: z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/),
    passphrase: z.string().max(1024),
  })
  .strict();
export type NativeSecret = z.infer<typeof nativeSecretSchema>;
export type NativeEnvelope = z.infer<typeof envelopeSchema>;
export function validateNativePassword(
  password: string,
  confirmation?: string,
) {
  if (password.length < 12 || new TextEncoder().encode(password).length > 1024)
    throw new Error("Use 12 or more characters, up to 1,024 UTF-8 bytes.");
  if (confirmation !== undefined && password !== confirmation)
    throw new Error("Passwords do not match.");
}
const aad = (envelope: Omit<NativeEnvelope, "ciphertext">) =>
  new TextEncoder().encode(JSON.stringify(envelope));
function header(e: NativeEnvelope) {
  return {
    version: e.version,
    id: e.id,
    revision: e.revision,
    iterations: e.iterations,
    salt: e.salt,
    nonce: e.nonce,
  } as const;
}
async function key(password: string, salt: Uint8Array) {
  const bytes = new TextEncoder().encode(password);
  try {
    return await pbkdf2Async(sha256, bytes, salt, {
      c: 600000,
      dkLen: 32,
      asyncTick: 8,
    });
  } finally {
    bytes.fill(0);
  }
}
export async function encryptNativeSecret(
  secret: NativeSecret,
  password: string,
  random: EntropySource,
  previous?: NativeEnvelope,
): Promise<NativeEnvelope> {
  validateNativePassword(password);
  nativeSecretSchema.parse(secret);
  const salt = random(16),
    nonce = random(12),
    base = {
      version: 1 as const,
      id: previous?.id ?? bytesToHex(random(16)),
      revision: (previous?.revision ?? 0) + 1,
      iterations: 600000 as const,
      salt: bytesToHex(salt),
      nonce: bytesToHex(nonce),
    };
  const derived = await key(password, salt),
    plain = new TextEncoder().encode(JSON.stringify(secret));
  try {
    return envelopeSchema.parse({
      ...base,
      ciphertext: bytesToHex(gcm(derived, nonce, aad(base)).encrypt(plain)),
    });
  } finally {
    derived.fill(0);
    plain.fill(0);
  }
}
export async function decryptNativeSecret(
  raw: string,
  password: string,
): Promise<{ secret: NativeSecret; envelope: NativeEnvelope }> {
  let derived: Uint8Array | undefined, plain: Uint8Array | undefined;
  try {
    if (raw.length > 8192) throw new Error("Envelope too large");
    validateNativePassword(password);
    const envelope = envelopeSchema.parse(JSON.parse(raw));
    derived = await key(password, hexToBytes(envelope.salt));
    plain = gcm(
      derived,
      hexToBytes(envelope.nonce),
      aad(header(envelope)),
    ).decrypt(hexToBytes(envelope.ciphertext));
    return {
      secret: nativeSecretSchema.parse(
        JSON.parse(new TextDecoder().decode(plain)),
      ),
      envelope,
    };
  } catch {
    throw new Error(
      "Could not unlock this wallet. Check your password or restore your recovery phrase.",
    );
  } finally {
    derived?.fill(0);
    plain?.fill(0);
  }
}
