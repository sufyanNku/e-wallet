import { rm } from "node:fs/promises";
// Disposable browser-test database only; never use the user's wallet database.
const directory = ".local/accounts-browser";
await rm(directory, { recursive: true, force: true });
process.env.NODE_ENV = "test";
process.env.EWALLET_MODE = "local";
process.env.HOST = "127.0.0.1";
process.env.PORT = "8877";
process.env.EWALLET_PUBLIC_ORIGINS = "http://127.0.0.1:8877";
process.env.EWALLET_DATABASE_PATH = directory + "/backend.sqlite";
process.env.EWALLET_ACCOUNTS = "1";
await import("./setup-accounts.ts");
const { buildServer } = await import("../services/backend/src/server");
const app = await buildServer();
await app.listen({ host: "127.0.0.1", port: 8877 });
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
