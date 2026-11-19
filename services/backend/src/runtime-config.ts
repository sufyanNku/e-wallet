export type RuntimeConfig = {
  origins: string[];
  hosts: string[];
  deployed: boolean;
  host: string;
  port: number;
  databasePath: string;
};
export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const deployed = env.NODE_ENV === "production";
  const origins = env.EWALLET_PUBLIC_ORIGINS
    ? env.EWALLET_PUBLIC_ORIGINS.split(",").map((value) => {
        const url = new URL(value.trim());
        if (
          url.origin !== value.trim() ||
          url.username ||
          url.password ||
          (url.protocol !== "https:" &&
            (deployed || !["127.0.0.1", "localhost"].includes(url.hostname)))
        )
          throw new Error(
            "EWALLET_PUBLIC_ORIGINS must contain exact HTTPS origins.",
          );
        return url.origin;
      })
    : deployed
      ? []
      : ["http://127.0.0.1:8787", "http://127.0.0.1:5173"];
  if (!origins.length)
    throw new Error("Set EWALLET_PUBLIC_ORIGINS for a deployed service.");
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const hosts = origins.map((origin) => new URL(origin).host);
  if (deployed) hosts.push("127.0.0.1:" + port);
  return {
    origins,
    hosts,
    deployed,
    port,
    host: env.HOST ?? "127.0.0.1",
    databasePath:
      env.EWALLET_DATABASE_PATH ??
      `.local/${env.EWALLET_MODE ?? "local"}/backend.sqlite`,
  };
}
