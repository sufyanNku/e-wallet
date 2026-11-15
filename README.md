# e-wallet

A browser wallet implemented from specifications **01–04**: a React UI, a dedicated signing Worker, real EVM/Solana/Bitcoin adapters, local contracts, reproducible fixtures, SQLite indexing, safe metadata and browser popup connectors. Test assets have no monetary value. The optional fifth specification is absent and outside this implementation scope.

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

`seed:local` resumes each family's journal, reconciles uncertain submissions, validates deployment identities, indexes actual public activity, checks balances and writes `artifacts/seed/local-manifest.json`. A repeat within the same ledger epoch preserves balances and holdings. `dev` uses existing nodes and runs the trusted local bridge relayer; it never resets or silently reseeds them. `pnpm relayer --once` resumes bridge minting separately. Keep the connection window open to receive lock/disconnect events; each new signing action opens its own review window.

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
