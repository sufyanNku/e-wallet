# e-wallet

New here? Read [USER_AND_TESTING_GUIDE.md](USER_AND_TESTING_GUIDE.md) for all 28 feature groups, step-by-step usage and developer checks. After local setup, stop development servers and run `pnpm test:all:local` for the sequential application regression suite.

A self-custody wallet with a redesigned React web client and a **React Native / Expo Android and iOS app**. The existing EVM, Solana and Bitcoin integrations are retained. Native and web signing run on the user's device; the backend handles public data.

**Current release: early access, local chains and testnets only. Real funds are disabled.** The November 19 product expansion supersedes the original browser-only scope in specification 01. Implementation and verification evidence for this expansion lives under `artifacts/product/`; the original four specification gates remain historical evidence rather than a production-launch certification.

**Current priority: testing and instructor presentations.** Real-funds client launch is deferred until the team chooses to resume it. The web and native interfaces use ordinary wallet wording; that presentation change does not enable real funds, change network identities, or certify production readiness.

The product now includes wallet-first navigation, token search, a command palette, notifications, market discovery, native secure storage, QR receive/scanning, native transaction review, on-chain balances/history, local swaps and collectible transfer flows. Market watch uses Coinbase spot quotes; demo portfolio values remain clearly separate. Original e-wallet branding is retained.

## Classroom logins and RBAC

For a two-account presentation, follow [RBAC_DEMO_GUIDE.md](RBAC_DEMO_GUIDE.md). Run `pnpm build:wallet`, `pnpm demo:setup`, then `pnpm demo:dev`, and open **http://127.0.0.1:5173/accounts**. Alice and Bob are Members; separate Admin and Auditor accounts demonstrate server-enforced permissions. Passwords are generated locally under ignored `.local/`. This area transfers **SQLite demo credits**, not blockchain assets or real money. It is disabled by default and unavailable in production/testnet mode. No chain node is needed for the classroom ledger.

## Android and iOS

For direct phone installation without publishing, follow [MOBILE_INSTALLATION_GUIDE.md](MOBILE_INSTALLATION_GUIDE.md).

```sh
pnpm install --frozen-lockfile
pnpm dev                         # backend + web + reference dapp
# In another terminal:
pnpm mobile                      # Metro for a development build
pnpm mobile:android              # build and run on Android
pnpm mobile:ios                  # build and run on macOS with Xcode
pnpm mobile:typecheck
pnpm mobile:export               # bundle both native targets; not signed store binaries
pnpm mobile:build:android        # memory-conscious debug APK build
pnpm mobile:test:chains          # actual chain proofs; disposable Solana/Bitcoin nodes
```

The default development API is `http://127.0.0.1:8787`. For Android devices/emulators, run `adb reverse tcp:8787 tcp:8787` and `adb reverse tcp:8081 tcp:8081`. A physical iPhone needs a reachable HTTPS API configured through `EXPO_PUBLIC_API_URL`; native API sessions intentionally differ from browser cookie sessions. Changing public environment variables requires rebuilding the app. `pnpm mobile:ios` requires macOS, Xcode and signing setup; Linux cannot verify the iOS executable.

Native wallet envelopes use PBKDF2-SHA256 (600,000 iterations) and AES-256-GCM, stored using Expo SecureStore backed by the device Keychain/Keystore. Public preferences, history and signed transaction journals use on-device SQLite. Signing derives the same EVM, SLIP-0010 Solana and BIP84/BIP86 regtest addresses as the browser vectors. The app locks on backgrounding and after five minutes of inactivity. Sensitive screens request capture protection; native task-switcher privacy covers are included. No recovery phrase or private key is sent to the API.

The verified debug APK is also preserved at `.local/releases/e-wallet-0.2.0-debug.apk`. It is a development build and requires Metro. It is not a store distribution package. Store-targeted builds refuse the public debug signing key and require HTTPS configuration, client-owned signing credentials and physical-device acceptance. Native external dapp connection protocols and biometric unlock are not yet implemented; the web popup connector remains available. Do not treat a successful JavaScript bundle or Node-hosted signing proof as a device security audit.

## Deployment and real-fund activation

The future launch track is deferred, not cancelled. On resumption, confirm target networks, obtain client-owned domain/RPC and Apple/Google developer accounts, complete mainnet adapters and vault isolation, run physical-device and recovery/incident drills, obtain an independent security audit, and complete privacy/legal and signing/distribution approvals. All requirements in `release-config.json` remain enforced; none is considered complete because the interface labels changed.

`infra/deployment/` contains an HTTPS reverse-proxy deployment, persistent SQLite storage, an unprivileged API container and health checks. `.env.example` documents the domain/API settings. No deployment or app-store upload has been performed.

```sh
pnpm release:check
# On the deployment host, after setting EWALLET_DOMAIN:
docker compose --env-file .env --file infra/deployment/compose.yaml up --build -d
```

`release-config.json` records real-fund release prerequisites. **There is no safe one-click mainnet activation in this build yet.** Mainnet adapters/indexing, isolated mainnet vaults, independent audit, production RPC provisioning, physical-device tests and store credentials remain release work. The checker keeps these explicit and cannot enable real funds by flipping an unchecked flag. No real recovery phrase should be imported into this early-access build.

## Start the real local demo

Use pnpm **10.34.9**, pinned in `packageManager`. The workspace pins Node **24.22.3** through `useNodeVersion`: pnpm downloads that runtime on first use and uses it for project commands, even when the terminal's `node` is version 22. `.nvmrc` records the same version for nvm users. Docker Engine and Compose are required for chain nodes. Initial setup needs internet; native binaries, the metadata program, dependencies and Docker images are cached for subsequent local runs. Recommended resources: 16 GB RAM and 25 GB free disk.

```sh
pnpm node --version        # should print v24.22.3
pnpm install --frozen-lockfile
pnpm preflight
pnpm infra:up
pnpm seed:local
pnpm dev
```

Open the wallet at **http://127.0.0.1:5173** and the reference dapp at **http://127.0.0.1:5174**. Built approval windows and the backend use **http://127.0.0.1:8787**. Browser vault storage belongs to an exact origin: restore the local fixture separately at 8787 when testing its connector. Each approval window unlocks independently.

The backend database is **SQLite**, accessed through `better-sqlite3`, with migrations, foreign keys and WAL enabled. Local data lives in `.local/local/backend.sqlite`; testnet mode uses `.local/testnet/backend.sqlite`. The browser keeps its encrypted wallet vault in **IndexedDB**, separately for local and testnet modes. Recovery phrases and private keys are not stored in the backend database.

`seed:local` resumes each family's journal, reconciles uncertain submissions, validates deployment identities, indexes actual public activity, checks balances and writes `artifacts/seed/local-manifest.json`. A repeat within the same ledger epoch preserves balances and holdings. `dev` uses existing nodes and runs the trusted local bridge relayer; it never resets or silently reseeds them. Continuous relay observations go to ignored `.local/bridge-status.json`, so normal development does not change tracked evidence timestamps. `pnpm relayer --once` resumes bridge minting separately and explicitly refreshes `artifacts/seed/bridge-status.json`. Keep the connection window open to receive lock/disconnect events; each new signing action opens its own review window.

Seeding also archives public fixture activity in `.local/local/backend.sqlite`. Registering the same public account in a new browser session reattaches matching canonical history; session permissions remain separate. This preserves indexed history when the upstream validator later prunes old signatures.

Public, deliberately insecure fixture identities are Alice (`01` repeated 32 bytes), Bob (`02`), Carol (`03`) and Dana (`04`). Seed commands generate their recovery phrases under ignored `.local/secrets/<name>.json`, with owner-only permissions. Import Alice for the populated demo; Bob/Carol are independent multisig owners; Dana is empty. These identities must never be used on public networks or for real funds. Testnet identities are generated randomly under a different ignored directory.

`pnpm infra:up` reuses the pinned images if present. Use `pnpm infra:up -- --rebuild` after changing node image sources. Compose uses only the `ewallet-demo` project, loopback ports and labelled project volumes. Verified native/program build provenance is in `toolchain-lock.json` and `infra/metaplex-build.json`; the pinned Metaplex program is included under `artifacts/programs/` for offline evaluation.

## Modes and evidence

```sh
pnpm dev:ui                 # frontend-only mock preview; no nodes required
pnpm build:wallet           # real local build
pnpm build:testnet          # public-testnet build; separate vault namespace
pnpm serve:web              # serve the currently built wallet at 8787
pnpm seed:assert            # read-only balance/state reconciliation
pnpm networks:check         # independent actual RPC identity checks
pnpm seed:testnets          # random testnet identities, free airdrop attempt, per-network report
```

Mock mode uses invalid sample recovery words and in-memory fixtures. Local mode executes real transactions on local nodes. Public-testnet results are reported independently in `artifacts/seed/testnet-manifest.json`; the current random identities lack gas, so execution is marked `blocked_funding`. The free Devnet airdrop was unavailable/rate limited. No paid funding, faucet bypass or mock success is substituted. The report includes public addresses and free-faucet references for later continuation.

The Evaluation screen reads the public manifests and actual network observations. Evidence files record observed timestamps and ledger fingerprints. Existing main-validator history includes some older pruned signatures; those are labelled `pruned`, current holdings are independently reconciled, and disposable fresh-validator tests cover complete seed history. A fresh validator retains up to 2,000,000 blockstore entries.

## Verify

```sh
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm audit:verified
pnpm contracts:test
pnpm test:integration
pnpm build:wallet
pnpm test:browser-core
pnpm exec playwright test --config playwright.chains.config.ts
pnpm test:dapp
pnpm seed:assert
```

`test:dapp` verifies the built EVM popup and then uses disposable Solana/Bitcoin Compose projects for their ordinary wallet and popup flows. `pnpm test:browser-solana` and `pnpm test:browser-bitcoin` can run sequentially on smaller machines. They never reset the main ledgers. Chromium defaults to `/opt/google/chrome/chrome`; override `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if needed. Secret-screen tests disable screenshots, traces and videos, and use assertions that omit DOM snapshots.

Evidence is under `artifacts/phase-01/` through `artifacts/phase-04/`. `implementation-status.json` tracks each requested task. Public-network funding blockers remain visible even when the equivalent local operation passed.

```sh
pnpm scenario -- pending-evm
pnpm scenario -- replacement-evm
pnpm scenario -- reverted-evm
pnpm scenario -- reorg-evm
pnpm scenario -- rpc-outage
pnpm scenario -- relayer-timeout
```

EVM fault scenarios restore their local snapshot and automining in cleanup. Reorg evidence uses real block rollback, inclusion-hash comparison, database restart and replay. Transport outages and relayer withholding are explicitly labelled controlled fault injection. Solana expiry tests use a labelled controlled blockhash fixture; Bitcoin pending/mempool tests use its disposable node.

## Reset and persistence

Stop `pnpm dev` and any evaluation server before resetting. This command destroys the current project's chain volumes, archives its local journals/databases, and recreates the local dataset:

```sh
pnpm reset:local -- --confirm=ewallet-demo
```

Vault maturity follows actual chain time: the initial one-hour position can naturally become withdrawable during a long session. A seed rerun preserves it rather than extending its lock.

The reset command validates exact project labels, named volumes and fixed checkout paths. It never runs Docker prune, resets public networks or clears browser vault storage. Browser reset is a separate password-protected wallet action. Back up recovery information before clearing browser storage.

Hardhat is ephemeral across process restarts. New EVM boot epochs invalidate previous pending records and deployment evidence. `seed:local` reconstructs both bridge chains together if only one changed, while retaining persistent Solana/Bitcoin ledgers. Backend/browser restarts preserve SQLite checkpoints; orphaned activity stays visibly orphaned until canonical replay.

## Connector and API boundaries

Integrating sites import `createEWalletConnector({ walletUrl })` from `packages/provider`. The EVM interface follows EIP-1193 request/events. `registerEWalletSolana(connector)` registers a Wallet Standard wallet inside the integrating dapp. Bitcoin uses the documented project API: `getAccounts`, `getNetwork`, `signPsbt(psbt, changeIndex?)`, `broadcastTransaction(hex)`, and `disconnect`; no universal Bitcoin provider is claimed. See `packages/provider/README.md` for examples and supported payloads.

Popup messages bind the exact origin, window, nonce, version and request ID. Grants expire after 24 hours; every signature/send requires a new review. Messages are limited to 16 KiB, transport requests to 128 KiB, and only supported decoded operations are signed. Solana external signing accepts one native System transfer with bounded compute/memo instructions, legacy/v0 messages, no lookup tables, nonce accounts or extra signers. The wallet preserves the exact supplied message/blockhash. Unsupported instructions fail closed. Bitcoin accepts 1–10 owned confirmed inputs, one recipient and optional independently derived internal change; arbitrary sighash flags are refused. Broadcasting accepts only an exact prior authorization for the same site/account/network.

All application endpoints are under `/api/v1`, use `{data, meta}` or structured errors, and protect session-scoped watches. Bitcoin descriptors are sent only after explicit privacy consent. Read endpoints include balances/assets/collectibles/activity/transaction details/contracts/notifications, with cursor pagination and freshness information. No signing, mnemonic, private-key, mining or reset endpoint exists. The reference server's development helpers perform fixed public reads and prepare public fixture PSBTs; they cannot administer nodes or sign.

NFT metadata defaults to neutral placeholders. User-requested media goes through HTTPS/IPFS validation, DNS/IP pinning, redirect/time/size limits and raster re-encoding. SVG/HTML/active content and private destinations are refused. Remote media can be disabled in Settings. Metadata failures do not block supported transfers.

Base fee previews include observed L1 data and operator components, with a reserve rechecked before signing. Arc's native 18-decimal USDC and its 6-decimal token view are treated as one canonical asset. Financial amounts remain integer strings throughout the browser, API and database. Synthetic valuations are labelled **Demo value**.

Primary references for the updated configuration: [Polygon RPCs](https://docs.polygon.technology/pos/reference/rpc-endpoints), [OP fee oracle](https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/src/L2/GasPriceOracle.sol), [Wallet Standard](https://github.com/wallet-standard/wallet-standard/blob/master/extensions/solana.md), [Arc connection details](https://docs.arc.io/arc/references/connect-to-arc), [Solana public endpoint limits](https://solana.com/docs/references/clusters).

Hardhat still depends on Zod 3.25.76. A source-controlled security backport rejects oversized constrained arrays/sets before walking elements, following the upstream fix for CVE-2023-54404. `security-patches.json` records the patch checksum and tests. `pnpm audit:verified` checks that checksum and the live parser behavior before exempting this exact version-only registry finding; other advisories fail normally. An unfiltered `pnpm audit` still reports the original package version. The wallet/backend use patched Zod 4.6.7.
# e-wallet

Android compilation and both native bundles passed. The local emulator remained ADB-offline in a fresh boot attempt, so device acceptance is explicitly unverified in `artifacts/product/device-acceptance.json`.

Native integration references: [Expo monorepos](https://docs.expo.dev/guides/monorepos/), [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/), [screen capture](https://docs.expo.dev/versions/latest/sdk/screen-capture/), and [Coinbase spot-price API](https://docs.cdp.coinbase.com/coinbase-app/track-apis/prices).
