process.env.EWALLET_ACCOUNTS = "1";
process.argv[2] = "wallet";
await import("./dev.ts");
export {};
