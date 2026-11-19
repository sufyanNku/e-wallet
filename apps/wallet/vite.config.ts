import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import wasm from 'vite-plugin-wasm';
import { fileURLToPath } from "node:url";
export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwind(),wasm(),{name:'wallet-build-config',generateBundle(){this.emitFile({type:'asset',fileName:'wallet-config.json',source:JSON.stringify({schemaVersion:1,protocolVersion:1,appVersion:'0.1.0',mode:mode==='testnet'?'testnet':'local'})});}}],
  worker:{format:'es',plugins:()=>[wasm()]},
  define: {
    __WALLET_MODE__: JSON.stringify(
      mode === "testnet" ? "testnet" : "local",
    ),
  },
  resolve: {
    alias: [{find:'@ewallet/domain/deployments',replacement:fileURLToPath(new URL('../../packages/domain/src/deployments.ts',import.meta.url))},{find:'@ewallet/config/abis',replacement:fileURLToPath(new URL('../../packages/config/src/abis.generated.ts',import.meta.url))},{find:'@ewallet/domain/protocol',replacement:fileURLToPath(new URL('../../packages/domain/src/worker-protocol.ts',import.meta.url))},...Object.entries(Object.fromEntries(
      [
        "domain",
        "config",
        "ui",
        "wallet-core",
        "provider",
        "chain-evm",
        "chain-solana",
        "chain-bitcoin",
      ].map((p) => [
        `@ewallet/${p}`,
        fileURLToPath(
          new URL(`../../packages/${p}/src/index.ts`, import.meta.url),
        ),
      ]),
    )).map(([name,replacement])=>({find:new RegExp(`^${name}$`),replacement}))],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    forwardConsole: false,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  devtools: false,
  build: { outDir: "dist", sourcemap: false,target:'esnext' },
}));
