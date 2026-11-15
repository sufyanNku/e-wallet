import { z } from "zod";
import { WalletError } from "@ewallet/domain";
export const envelopeSchema = z
  .object({
    version: z.literal(1),
    walletId: z.string().uuid(),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    kdf: z
      .object({
        name: z.literal("PBKDF2"),
        hash: z.literal("SHA-256"),
        iterations: z.literal(600000),
        saltBase64: z.string().length(24),
      })
      .strict(),
    cipher: z
      .object({
        name: z.literal("AES-GCM"),
        ivBase64: z.string().length(16),
        tagLength: z.literal(128),
        ciphertextBase64: z.string().min(24).max(32768),
      })
      .strict(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type VaultEnvelope = z.infer<typeof envelopeSchema>;
export const secretSchema = z
  .object({
    entropyHex: z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/),
    passphrase: z.string().max(1024),
    derivationVersion: z.literal(1),
  })
  .strict();
export type VaultSecret = z.infer<typeof secretSchema>;
export function base64(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}
export function unbase64(text: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
    throw new Error("Malformed base64");
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (base64(bytes) !== text) throw new Error("Noncanonical base64");
  return bytes;
}
export function hex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function unhex(text: string) {
  if (!/^(?:[a-f0-9]{2})+$/.test(text)) throw new Error("Invalid hex");
  return Uint8Array.from(text.match(/../g)!, (s) => parseInt(s, 16));
}
export function validatePassword(password: string, confirmation?: string) {
  const bytes = new TextEncoder().encode(password);
  if (password.length < 12 || bytes.byteLength > 1024)
    throw new WalletError(
      "PASSWORD_POLICY",
      "Use at least 12 characters and at most 1,024 UTF-8 bytes.",
    );
  if (confirmation !== undefined && password !== confirmation)
    throw new WalletError("PASSWORD_MISMATCH", "Passwords do not match.");
}
const buffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;
export function canonicalAad(e: VaultEnvelope) {
  return new TextEncoder().encode(
    JSON.stringify({
      version: e.version,
      walletId: e.walletId,
      revision: e.revision,
      kdf: {
        name: e.kdf.name,
        hash: e.kdf.hash,
        iterations: e.kdf.iterations,
        saltBase64: e.kdf.saltBase64,
      },
      cipher: {
        name: e.cipher.name,
        ivBase64: e.cipher.ivBase64,
        tagLength: e.cipher.tagLength,
      },
      createdAt: e.createdAt,
    }),
  );
}
async function derive(password: string, salt: Uint8Array) {
  const bytes = new TextEncoder().encode(password);
  try {
    const source = await crypto.subtle.importKey(
      "raw",
      buffer(bytes),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: 600000,
        salt: buffer(salt),
      },
      source,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    bytes.fill(0);
  }
}
export function parseEnvelope(value: unknown) {
  const e = envelopeSchema.parse(value);
  if (
    unbase64(e.kdf.saltBase64).length !== 16 ||
    unbase64(e.cipher.ivBase64).length !== 12 ||
    unbase64(e.cipher.ciphertextBase64).length < 16
  )
    throw new Error("Invalid envelope parameters");
  return e;
}
export async function seal(
  secret: VaultSecret,
  password: string,
  identity?: Pick<VaultEnvelope, "walletId" | "revision" | "createdAt">,
): Promise<VaultEnvelope> {
  validatePassword(password);
  secretSchema.parse(secret);
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const e: VaultEnvelope = {
    version: 1,
    walletId: identity?.walletId ?? crypto.randomUUID(),
    revision: identity?.revision ?? 1,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: 600000,
      saltBase64: base64(salt),
    },
    cipher: {
      name: "AES-GCM",
      ivBase64: base64(iv),
      tagLength: 128,
      ciphertextBase64: "",
    },
    createdAt: identity?.createdAt ?? new Date().toISOString(),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(secret));
  try {
    const key = await derive(password, salt);
    e.cipher.ciphertextBase64 = base64(
      new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: buffer(iv),
            tagLength: 128,
            additionalData: buffer(canonicalAad(e)),
          },
          key,
          buffer(bytes),
        ),
      ),
    );
    return parseEnvelope(e);
  } finally {
    bytes.fill(0);
  }
}
export async function unseal(
  input: unknown,
  password: string,
): Promise<VaultSecret> {
  try {
    validatePassword(password);
    const e = parseEnvelope(input),
      key = await derive(password, unbase64(e.kdf.saltBase64));
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: buffer(unbase64(e.cipher.ivBase64)),
          tagLength: 128,
          additionalData: buffer(canonicalAad(e)),
        },
        key,
        buffer(unbase64(e.cipher.ciphertextBase64)),
      ),
    );
    try {
      return secretSchema.parse(
        JSON.parse(new TextDecoder().decode(plaintext)),
      );
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new WalletError(
      "VAULT_DECRYPT",
      "Unable to unlock. Check your password or encrypted backup.",
    );
  }
}
