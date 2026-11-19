import "./report-paths.ts";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { open, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const directory = await mkdtemp(".local/dev-smoke-");
const logPath = ".local/reports/integration/dev-supervisor.log";
const log = await open(logPath, "w");
const blockers: Server[] = [];
let child: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  // Deliberately occupy every preferred port. Existing processes are retained.
  for (const port of [5173, 5174, 8787]) {
    const server = createServer((_request, response) =>
      response.end("unrelated-service"),
    );
    const bound = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) =>
        error.code === "EADDRINUSE" ? resolve(false) : reject(error),
      );
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (bound) blockers.push(server);
  }
  const env = {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "8787",
    EWALLET_WALLET_PORT: "5173",
    EWALLET_DAPP_PORT: "5174",
    EWALLET_DATABASE_PATH: directory + "/backend.sqlite",
    EWALLET_PUBLIC_ORIGINS: undefined,
    EWALLET_ACCOUNTS: "1",
  };
  await promisify(execFile)("pnpm", ["accounts:setup"], { env });
  child = spawn("pnpm", ["dev"], {
    stdio: ["ignore", log.fd, log.fd],
    env,
    detached: true,
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  let urls: { wallet: string; backend: string; reference: string } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (exited)
      throw new Error(
        "Development supervisor exited before readiness. See " + logPath,
      );
    const output = await readFile(logPath, "utf8");
    const wallet = output.match(
      /Open your wallet: (http:\/\/127\.0\.0\.1:\d+)/,
    )?.[1];
    const backend = output.match(
      /Backend and built approval windows: (http:\/\/127\.0\.0\.1:\d+)/,
    )?.[1];
    const reference = output.match(
      /Developer reference dapp \(connection tests\): (http:\/\/127\.0\.0\.1:\d+)/,
    )?.[1];
    if (wallet && backend && reference) {
      try {
        const responses = await Promise.all(
          [wallet, backend + "/api/v1/health", reference].map((url) =>
            fetch(url, { signal: AbortSignal.timeout(1000) }),
          ),
        );
        if (responses.every((response) => response.ok)) {
          assert.equal((await responses[1].json()).data.service, "e-wallet");
          urls = { wallet, backend, reference };
          break;
        }
      } catch {
        /* Wait for this launcher's own servers. */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(
    urls,
    "Dynamic development stack did not become ready; see " + logPath,
  );
  for (const url of Object.values(urls))
    assert.ok(!["5173", "5174", "8787"].includes(new URL(url).port));
  assert.equal(new Set(Object.values(urls)).size, 3);
  for (const server of blockers) assert.equal(server.listening, true);
  const connect = await fetch(urls.backend + "/connect");
  assert.equal(
    connect.headers.get("cross-origin-opener-policy"),
    "unsafe-none",
  );
  assert.equal(
    (await fetch(urls.backend)).headers.get("cross-origin-opener-policy"),
    "same-origin",
  );
  assert.ok(
    connect.headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'"),
  );
  const denied = await fetch(urls.backend + "/api/v1/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:59999",
      "Sec-Fetch-Site": "same-origin",
    },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/opt/google/chrome/chrome",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const credentials = JSON.parse(
    await readFile(directory + "/accounts-credentials.json", "utf8"),
  );
  await page.goto(urls.wallet + "/accounts");
  await page.getByLabel("Username", { exact: true }).fill("alice");
  await page
    .getByLabel("Password", { exact: true })
    .fill(
      credentials.find((c: { username: string }) => c.username === "alice")
        .password,
    );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("account-balance").waitFor();
  assert.equal(
    (await page.getByTestId("account-balance").textContent())?.trim(),
    "1000.00",
  );
  const identity = JSON.parse(
    await readFile(".local/secrets/alice.json", "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(".local/state/seed/evm-manifest.json", "utf8"),
  );
  const password = "Isolated development port test password";
  await page.goto(urls.wallet + "/import");
  await page
    .getByLabel("Recovery phrase (12 or 24 English words)")
    .fill(identity.mnemonic);
  await page.getByLabel("New wallet password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new wallet password").fill(password);
  await page
    .getByRole("button", { name: "Restore wallet", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your wallet", exact: true })
    .waitFor();
  await page
    .getByText("dUSDC", { exact: true })
    .first()
    .waitFor({ timeout: 20000 })
    .catch(async () => {
      throw new Error(
        "Dynamic wallet balance read failed: " +
          (await page.getByRole("alert").allTextContents()).join(" | "),
      );
    });
  // The built approval wallet owns a separate origin and vault.
  await page.goto(urls.backend + "/import");
  await page
    .getByLabel("Recovery phrase (12 or 24 English words)")
    .fill(identity.mnemonic);
  await page.getByLabel("New wallet password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new wallet password").fill(password);
  await page
    .getByRole("button", { name: "Restore wallet", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your wallet", exact: true })
    .waitFor();
  const reference = await context.newPage();
  await reference.goto(urls.reference);
  assert.equal(
    await reference
      .getByRole("link", { name: "Open wallet" })
      .getAttribute("href"),
    urls.wallet,
  );
  const popupPromise = context.waitForEvent("page");
  await reference
    .getByRole("button", { name: "Connect evm", exact: true })
    .click();
  const popup = await popupPromise;
  await popup.waitForURL(urls.backend + "/connect**");
  await popup.getByLabel("Wallet password", { exact: true }).fill(password);
  await popup
    .getByRole("button", { name: "Unlock approval window", exact: true })
    .click();
  await popup
    .getByRole("button", { name: "Approve connection", exact: true })
    .click();
  await reference
    .getByTestId("accounts")
    .filter({ hasText: manifest.identities.alice.evm.address })
    .waitFor();
  const blockhash = await fetch(urls.reference + "/reference/solana/blockhash");
  assert.equal(blockhash.status, 200);
  assert.ok((await blockhash.json()).data.value.blockhash);
  await writeFile(
    ".local/reports/integration/dev-supervisor-proof.json",
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        ...urls,
        ready: true,
        localMode: true,
        occupiedPreferredPorts: [5173, 5174, 8787],
        existingProcessesRetained: true,
        accountsLogin: true,
        nodeBackedWallet: true,
        connectorPopup: true,
        referencePublicReads: true,
        exactOriginsEnforced: true,
        openerPoliciesVerified: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Dynamic startup passed with all preferred ports occupied: login, node balances, popup connection, reference reads and origin protection verified.",
  );
} finally {
  await browser?.close();
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* Owned child already exited. */
    }
    await new Promise<void>((resolve) => {
      if (child?.exitCode !== null) resolve();
      else {
        child.once("exit", () => resolve());
        setTimeout(resolve, 5000).unref();
      }
    });
  }
  for (const server of blockers)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await log.close();
  await rm(directory, { recursive: true, force: true });
}
