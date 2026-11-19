import { mkdirSync } from "node:fs";

// Generated diagnostics stay outside tracked source and runtime seed state.
for (const directory of [
  "web",
  "core",
  "chains",
  "integration",
  "product",
  "full-suite/logs",
])
  mkdirSync(".local/reports/" + directory, { recursive: true });
