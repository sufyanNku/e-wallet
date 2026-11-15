const sensitive =
  /^(?:seed|mnemonic|password|confirmation|passphrase|privateKey|entropyHex|signedPayload|signedBytes|signedBytesBase64|signedTransaction|rawTransaction)$/i;
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[bounded]";
  if (Array.isArray(value))
    return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, v]) => [
          key,
          sensitive.test(key) ? "[redacted]" : redact(v, depth + 1),
        ]),
    );
  return value;
}
