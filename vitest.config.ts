import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: [{find:"@ewallet/config/rpc",replacement:fileURLToPath(new URL("./packages/config/src/rpc.ts",import.meta.url))},{find:'@ewallet/domain/deployments',replacement:fileURLToPath(new URL('./packages/domain/src/deployments.ts',import.meta.url))},{find:'@ewallet/config/abis',replacement:fileURLToPath(new URL('./packages/config/src/abis.generated.ts',import.meta.url))},
      {
        find: "@ewallet/domain/protocol",
        replacement: fileURLToPath(
          new URL("./packages/domain/src/worker-protocol.ts", import.meta.url),
        ),
      },
      ...Object.entries(
        Object.fromEntries(
          ["domain", "config", "ui", "wallet-core", "provider", "chain-evm", "chain-solana", "chain-bitcoin"].map((p) => [
            `@ewallet/${p}`,
            fileURLToPath(
              new URL(`./packages/${p}/src/index.ts`, import.meta.url),
            ),
          ]),
        ),
      ).map(([name, replacement]) => ({
        find: new RegExp(`^${name}$`),
        replacement,
      })),
    ],
  },
  test: {
    maxWorkers:2,
    testTimeout:15000,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    reporters: ["default", "json"],
    outputFile: { json: "artifacts/unit-results.json" },
  },
});
