import * as Crypto from "expo-crypto";
import { registerRootComponent } from "expo";
import App from "./src/App";
// Hermes has secure randomness through the OS-backed Expo module. The shared
// Solana preparation path needs only digest; signing stays in native-wallet.
const nativeCrypto = {
  getRandomValues: Crypto.getRandomValues,
  randomUUID: Crypto.randomUUID,
  subtle: {
    digest: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      if (name !== "SHA-256" && name !== "SHA-512")
        throw new Error("Unsupported digest.");
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      return Crypto.digest(
        name === "SHA-256"
          ? Crypto.CryptoDigestAlgorithm.SHA256
          : Crypto.CryptoDigestAlgorithm.SHA512,
        bytes,
      );
    },
  },
};
if (!globalThis.crypto?.subtle)
  Object.defineProperty(globalThis, "crypto", {
    value: nativeCrypto,
    configurable: true,
  });
if (!globalThis.structuredClone)
  globalThis.structuredClone = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value));
registerRootComponent(App);
