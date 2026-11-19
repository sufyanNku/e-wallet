process.env.EWALLET_TEAM_DEMO = "1";
process.argv[2] = "wallet";
await import("./dev.ts");
export {};
