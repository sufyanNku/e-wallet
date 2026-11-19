import { referenceApi } from "./reference-api";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), referenceApi()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.EWALLET_DAPP_PORT ?? 5174),
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "unsafe-none",
      "Content-Security-Policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${new URL(process.env.VITE_EWALLET_APPROVAL_URL ?? "http://127.0.0.1:8787").origin}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`,
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
