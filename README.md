# e-wallet

e-wallet is a self-custody wallet for the web, Android and iOS. It supports Ethereum-compatible networks, Solana and Bitcoin, with device-side signing, asset management, payments, collectibles and connected applications. A separate Accounts area provides username login, credit transfers and server-enforced Member, Admin and Auditor permissions.

Start with the [user and developer guide](USER_AND_TESTING_GUIDE.md): it explains 28 feature groups, step-by-step use and how to test each feature. See the [Accounts guide](ACCOUNTS_GUIDE.md) for login and RBAC, and the [phone installation guide](MOBILE_INSTALLATION_GUIDE.md) for installation without public app stores.

## Run locally

Use pnpm **10.34.9**. The workspace selects Node **24.22.3** for project commands, including when the terminal's default Node is version 22. Docker Engine and Compose run the chain nodes. Initial setup requires internet; 16 GB RAM and 25 GB free disk are recommended.

```sh
pnpm install --frozen-lockfile
pnpm node --version
pnpm preflight
pnpm infra:up
pnpm seed:local
pnpm dev
```

Open the **Open your wallet** URL printed by `pnpm dev`. Preferred ports are 5173 for the wallet, 5174 for the reference application and 8787 for the backend/approval wallet. If occupied, the launcher automatically selects free ports and configures the API proxy, exact allowed origins and approval links together. It leaves existing services running. Append `/accounts` to the printed wallet URL for username login.

A newly created wallet is empty. Restore the prepared Alice phrase from the ignored `.local/secrets/alice.json` file to use seeded holdings. The local identities are deliberately public and insecure: never use them on public networks or for real funds. Accounts passwords are generated separately in `.local/local/accounts-credentials.json`.

Crypto wallets unlock with a wallet password and require no username. After creating a wallet on local web, you can optionally register a credit account with your own username and account password. Choose **Credit account** in the sidebar to return to it. New registrations are Members with zero credits; existing users can transfer credits to them. **Sign out of wallet** locks signing keys and ends the credit-account session; **Lock wallet** only locks the signing vault.

For Accounts without blockchain nodes:

```sh
pnpm dev:accounts
```

Each launch uses its own available ports. You can set preferred starting ports with `EWALLET_WALLET_PORT`, `EWALLET_DAPP_PORT` and `PORT`; occupied preferences still fall back automatically. Accounts is enabled and initialized automatically by `pnpm dev` in local development. Existing passwords, balances and history are preserved. Set `EWALLET_ACCOUNTS=0` to turn it off; production and public-testnet restrictions remain enforced.

A different wallet port is a different browser origin, with its own encrypted vault. Existing vaults remain at their original URLs. Use the printed addresses rather than an old bookmark.

## Data and seeding

The backend uses **SQLite**, with checked migrations, foreign keys and WAL. Local data lives in `.local/local/backend.sqlite`; testnet data uses `.local/testnet/backend.sqlite`.

- Account users, password hashes, roles, credit balances, receipts and audit history are in SQLite. Transfers commit debit, credit and receipt atomically. Repeating setup preserves existing passwords, balances, suspension status and history.
- Crypto balances and ownership come from the selected blockchain node. SQLite indexes public activity; no browser-local balance dataset supplies the wallet.
- The browser stores its encrypted signing vault in IndexedDB. Mobile stores its encrypted vault in SecureStore and public device data in on-device SQLite. Recovery phrases and private keys are never sent to the backend. Clearing device storage can remove the vault; retain recovery information.
- Browser contacts, permissions and preferences are device data. Clearing them does not reset SQLite credit balances or blockchain holdings.

`pnpm seed:local` resumes deployment journals, reconciles submissions and seeds the actual local chains. Runtime manifests and deployment addresses are generated under ignored `.local/state/`. Seed activity is indexed into SQLite. `pnpm seed:assert` independently checks balances and holdings. A repeat within the same ledger epoch preserves existing state. Development startup never resets or silently reseeds nodes.

Local reset is destructive. Stop development and test servers first, preserve recovery information, then use `pnpm reset:local -- --confirm=ewallet-demo` only when a fresh local dataset is intended. The command archives local databases/journals and validates project-owned volumes; it does not reset public networks or clear browser vaults.

## Verify changes

Stop development, Metro and other test servers, leaving the local chain nodes running:

```sh
pnpm test:all:local
```

The sequential suite checks types, lint, unit/security tests, contracts, browser flows, RBAC, indexing/reorgs, transaction recovery, seed consistency, native signing, both mobile bundles and Android debug compilation. Results and logs are generated under **`.local/reports/full-suite/`**, outside tracked source. The report lists checks that require physical devices or external funding separately.

Playwright files are necessary regression tests. They check the actual built application, payments, approvals, accessibility and responsive layouts; they are not loaded by the application. Secret-screen screenshots, videos and traces are disabled. A QR image is generated temporarily only to test the image scanner.

```sh
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm build:wallet
pnpm test:ui
pnpm test:accounts
```

Run chain tests sequentially. Chromium defaults to `/opt/google/chrome/chrome`; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for another installation. Android compilation needs a full JDK and Android SDK; iOS native builds need macOS/Xcode. A successful automated run does not establish that no possible bug exists.

Generated logs, reports, screenshots, builds and machine-specific state are ignored. The pinned Metaplex program, its license and build provenance under `artifacts/programs/` are retained for offline chain seeding. The SQL migration history, lockfile, contract sources, public media and security patch records are required source assets.

## Mobile

```sh
pnpm mobile
pnpm mobile:android
pnpm mobile:ios
pnpm mobile:typecheck
pnpm mobile:export
pnpm mobile:build:android
```

The Android debug package requires Metro. For USB development, reverse ports 8787 and 8081 with ADB. An iPhone needs a reachable HTTPS backend. Follow the [installation guide](MOBILE_INSTALLATION_GUIDE.md) for exact device, signing and standalone-build instructions. Native external dapp protocols and biometric unlock remain future work; physical-device acceptance is separate from compilation and Node-hosted signing tests.

## Connections and backend

Integrating sites use `createEWalletConnector({ walletUrl })` from `packages/provider`. EVM follows EIP-1193 request/events; `registerEWalletSolana(connector)` registers the Solana Wallet Standard interface. Bitcoin exposes this project's `getAccounts`, `getNetwork`, `signPsbt`, `broadcastTransaction` and `disconnect` methods. `apps/reference-dapp/` contains working integration examples.

Connections bind the requesting origin, window, nonce and request ID. Each signature or transfer needs explicit review. Unsupported operations fail closed. API endpoints under `/api/v1` serve public reads, session-scoped watches and the separate credit ledger; the API never holds signing keys. Remote collectible media is validated and re-encoded, and private destinations or active content are refused.

## Deployment and future real-funds launch

The current supported scope is local chains and public testnets. **Real funds remain disabled**, as requested. Public-testnet execution requires funded, randomly generated identities; unavailable faucets or RPCs are reported rather than replaced with a synthetic success.

`infra/deployment/` provides an HTTPS proxy, persistent SQLite storage, an unprivileged API container and health checks. `.env.example` documents configuration. No client deployment or public-store upload is implied by this source tree.

Future real-funds work remains in `release-config.json`: client-owned domains/RPCs and signing accounts, mainnet adapters and isolated vaults, physical-device and recovery checks, an independent security review, and deployment/distribution approvals. Run `pnpm release:check` to inspect those requirements. There is no completed one-click mainnet activation.

`pnpm audit:verified` validates the source-controlled Zod 3 security backport and its checksum before handling that exact version-only advisory. Other advisories fail normally; an unfiltered registry audit still reports the original dependency version. See `security-patches.json` and `patches/`.
