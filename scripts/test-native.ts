import { spawn } from "node:child_process";
for (const args of [
  ["exec", "tsx", "scripts/check-native-wallet.ts", "--family=evm"],
  ["exec", "tsx", "scripts/test-solana-browser.ts", "--native-only"],
  ["exec", "tsx", "scripts/test-bitcoin-browser.ts", "--native-only"],
]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Native chain verification failed.")),
    );
  });
}
