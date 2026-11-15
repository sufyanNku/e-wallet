import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
const dir = "artifacts/phase-01";
await mkdir(dir, { recursive: true });
const checks = [];
if(process.argv.includes("--resume")){const previous=JSON.parse(await readFile(`${dir}/verification.json`,"utf8"));checks.push(...previous.checks.filter(c=>c.state==="passed"&&c.command!=="pnpm build:web"));}
for (const args of [
  ["build:web"],
  ["typecheck"],
  ["lint"],
  ["test:unit"],
  ["test:ui"],
  ["audit:verified"],
]) {
  if(checks.some(c=>c.command===`pnpm ${args.join(" ")}`))continue;
  const name = args[0];
  const start = new Date().toISOString();
  const result = await new Promise((resolve) => {
    const child = spawn("pnpm", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    for (const pipe of [child.stdout, child.stderr])
      pipe.on("data", (b) => {
        out += b;
        process.stdout.write(b);
      });
    child.on("error", (e) => resolve({ exitCode: 1, output: e.message }));
    child.on("close", (code) => resolve({ exitCode: code, output: out }));
  });
  const path = `${dir}/${name}.log`;
  await writeFile(path, result.output);
  checks.push({
    command: `pnpm ${args.join(" ")}`,
    state: result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
    startedAt: start,
    completedAt: new Date().toISOString(),
    evidencePath: path,
  });
}
await writeFile(
  `${dir}/verification.json`,
  JSON.stringify({ checks }, null, 2) + "\n",
);
const status = JSON.parse(await readFile("implementation-status.json", "utf8"));
const phase = status.phases.find((p) => p.phase === "01");
const success = checks.every((c) => c.state === "passed");
phase.checks = checks;
phase.state = success ? "passed" : "failed";
phase.remainingBlockers = success
  ? []
  : checks.filter((c) => c.state === "failed").map((c) => c.command);
const pathMap = {
  F01: [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "eslint.config.js",
    "scripts/check-boundaries.mjs",
  ],
  F02: ["packages/domain/src/index.ts", "packages/config/src/index.ts"],
  F03: ["packages/ui/src/components.tsx", "apps/wallet/src/styles.css"],
  F04: ["apps/wallet/src/onboarding.tsx", "apps/wallet/src/mock-gateway.ts"],
  F05: ["apps/wallet/src/payments.tsx", "apps/wallet/src/portfolio.tsx"],
  F06: ["apps/wallet/src/services.tsx", "apps/wallet/src/context.tsx"],
  F07: ["apps/wallet/src/settings.tsx"],
  F08: ["apps/wallet/src/App.tsx", "services/backend/src/server.ts"],
  F09: ["tests", "artifacts/phase-01"],
};
for (const task of phase.tasks) {
  task.state = success ? "passed" : "in_progress";
  task.changedPaths = pathMap[task.taskId];
  task.checks = checks;
  task.evidencePaths = [
    `${dir}/verification.json`,
    `${dir}/browser-results.json`,
    `${dir}/accessibility.json`,
  ];
  task.remainingBlockers = phase.remainingBlockers;
}
phase.evidencePaths = (await readdir(dir)).map((p) => `${dir}/${p}`);
status.updatedAt = new Date().toISOString();
await writeFile(
  "implementation-status.json",
  JSON.stringify(status, null, 2) + "\n",
);
if (!success) process.exitCode = 1;
