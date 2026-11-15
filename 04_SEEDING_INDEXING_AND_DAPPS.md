# 04 — Reproducible test data, indexing and web dapp connections

**Prerequisite:** Gate G3 in [03_CHAINS_CONTRACTS_AND_TRANSACTIONS.md](03_CHAINS_CONTRACTS_AND_TRANSACTIONS.md).  
**Outcome:** one reproducible local environment, a populated real wallet demonstration, reliable public-data indexing and working browser-to-browser dapp approvals. All amounts below are test assets.

## 1. Infrastructure and free execution

Use Docker Engine/Compose for nodes and optionally the backend; use Node/pnpm on the host for development. Provide pinned Dockerfiles when an upstream project does not publish a suitable official image. Download binaries only from official releases, verify checksums/signatures where available, and record versions/digests in `toolchain-lock.json`. Never use an arbitrary community image just because it has the right name.

| Service | Host address | Persistence and role |
|---|---|---|
| Wallet development server | `127.0.0.1:5173` | Real browser UI or explicitly selected mock mode |
| Reference dapp | `127.0.0.1:5174` | Separate origin; integration SDK and test controls |
| Backend/static evaluation host | `127.0.0.1:8787` | SQLite, metadata, restricted RPC and built wallet |
| Hardhat A | `127.0.0.1:8545` | EVM chain 31337; primary demo contracts |
| Hardhat B | `127.0.0.1:8546` | EVM chain 31338; bridge destination simulation |
| Solana test validator | `127.0.0.1:8899`; WS 8900 | Persistent local ledger and metadata program |
| Bitcoin Core regtest | Internal RPC 18443; optional loopback diagnostic mapping | Persistent chain; separate miner and watch-only wallets |

Use Compose project name `ewallet-demo` and project-specific volumes. No node admin RPC is exposed to the internet. Browser code never receives Core credentials or a Hardhat funding private key. Use separate application API methods rather than exposing `hardhat_setBalance`, mining, `sendtoaddress`, arbitrary RPC or a shell command through HTTP.

Hardhat node state is treated as ephemeral across node-process restarts; mounting a volume does not make its in-memory ledger durable. Persist Solana/Bitcoin ledgers and SQLite normally. Assign each local EVM process a fresh boot-epoch ID, retain it in the supervisor's state and manifests, and also verify deployment code/block height. A new EVM epoch invalidates old receipts, pending operations and cursors even if the deterministic genesis hash is unchanged. Mark the environment `needs_seed` and rebuild the affected EVM dataset with `seed:local`; never rebroadcast an old pending operation into the new ledger. If only one bridge chain resets, refuse the bridge demo until both local EVM datasets have been reconciled as one fresh pair. Backend/browser restarts without node restarts preserve ordinary history; full node restarts follow this documented reseed procedure.

Preflight checks: Node/pnpm versions, Docker/Compose availability, occupied ports, writable local state, secure browser context and free disk. Recommend 16GB RAM and 25GB free disk for the full stack; frontend-only work should run without nodes. On a smaller machine support sequential chain test profiles, and report what was actually exercised. Health checks have timeouts and actionable errors rather than indefinite waiting.

Prepare the Solana metadata program before offline evaluation. Use the official Metaplex release/source at a pinned commit, build the program reproducibly or obtain its official verified program artifact, and load it at its documented program ID when starting the validator. Record source commit, build tools and binary hash. Do not dynamically clone unknown mainnet programs at every startup. Test that the real metadata account can be created/read locally; a JSON fixture alone is not an on-chain metadata account.

Initial setup needs internet for packages/binaries. Cache the required artifacts so the subsequent local demo can run offline. Do not require a full mainnet node or paid archive/indexer service.

## 2. Three distinct data modes

| Mode | Purpose | Permitted data | Success claims |
|---|---|---|---|
| `mock` | Frontend development | Fixed JSON scenarios, synthetic errors/states | UI behavior only |
| `local` | Mandatory reproducible evaluation | Real transactions on local EVM/Solana/Bitcoin | Real local execution, not public-network verification |
| `testnet` | Nine-family network evidence | Independently funded public test accounts; Bitcoin remains labelled regtest | Only the networks/operations actually observed |

No automatic mode fallback. An unavailable testnet produces an unavailable/pending state, never a successful mock transaction. Synthetic fiat prices are always labelled “Demo value”; use integer micro-USD rates. Price changes are fixture scenarios, not market data.

Separate directories, browser data stores, deployment manifests and seed namespaces by mode. Exclude local-demo secret fixtures and seed-admin tooling from the normal web build. A dedicated local evaluation bundle may expose an explicit “Load demo wallet” convenience, but it must be build-gated to local mode, verify loopback and expected local genesis/chain identities, and never connect that public fixture wallet to public testnets.

## 3. Deterministic identities and initial allocations

For local fixtures only, generate BIP39 phrases from four fixed 32-byte entropy values: Alice=`0x01` repeated 32 times, Bob=`0x02` repeated 32 times, Carol=`0x03` repeated 32 times, Dana=`0x04` repeated 32 times. These are deliberately public, insecure test identities. Use the derivation paths in file 02. Store the entropy mapping in a test-only fixture, not the production frontend. Generate private seed files under ignored `.local/secrets/` with owner-only permissions where supported. Do not print private keys into routine logs.

Alice is the primary evaluation user; Bob and Carol are independent counterparties and the other two multisig owners; Dana is an empty-wallet case. Use a separate local deployer/miner identity. Public-testnet identities must be generated randomly and stored outside version control; never reuse these published local identities.

### EVM A allocations before scenario transactions

| Identity/component | Native test ETH | dUSDC (6 decimals) | dDAI (18 decimals) | EWLT (18 decimals) |
|---|---:|---:|---:|---:|
| Alice | 100 | 10,000 | 10,000 | 2,500 |
| Bob | 100 | 5,000 | 5,000 | 1,000 |
| Carol | 100 | 5,000 | 5,000 | 1,000 |
| Dana | 0 | 0 | 0 | 0 |
| Swap pool | 0 | 1,000,000 | 1,000,000 | 0 |

Choose total token cap 1 billion whole units per standard demo token. Mint only amounts needed for allocations and quotas. On EVM B fund Alice/Bob/Carol with 100 test ETH for fees; initialize bridge destination tokens at zero before the bridge fixture. Use a differently named `bdUSDC` destination representation so its simulated status is clear.

NFT fixtures: ERC-721 IDs 101 and 102 initially belong to Alice, 103 to Bob; ERC-1155 token 1 has quantity 5 for Alice and 2 for Bob, token 2 has quantity 10 for Alice. Add a test-only `USDC`-symbol impostor at a different contract address with quantity 7, marked unverified/hidden by default. Do not conflate it with dUSDC or Arc's native USDC.

### Solana allocations before scenario transactions

Alice/Bob/Carol each receive 100 local SOL. Alice receives 10,000 dUSDC at 6 decimals and 2,500 sEWLT at 9 decimals; Bob/Carol receive 5,000 dUSDC each. Create one extension-free Token-2022 fixture with 6 decimals and 100 units for Alice, plus a clearly unsupported extension fixture for rejection testing. Dana has no funds.

Create two standard noncompressed NFT mints with decimals 0, supply 1, appropriate revoked mint authority and real supported metadata accounts. Alice owns `Campus Pass #1`; Bob owns `Campus Pass #2`. Include one account with a supported SPL delegate for the revoke demonstration, a frozen token fixture for refusal, and a recipient with no ATA so account creation is exercised.

### Bitcoin allocations before scenario transactions

Create an isolated miner wallet, mine 101 blocks so coinbase funds become spendable, then fund public addresses derived from the fixture roots. Alice receives P2WPKH UTXOs of 0.50 and 0.25 BTC and P2TR UTXOs of 0.40 and 0.10 BTC. Bob and Carol each receive 0.10 BTC. Mine sufficient confirmation blocks after funding. Dana has none. Core's user watch wallet must contain public descriptors only; assert `private_keys_enabled=false`.

These are **opening allocations**, not final displayed balances. Subsequent real scenario transactions incur fees and change holdings. Compute final expected balances from executed operations and actual receipts, then query nodes and compare; never assert that Alice still has exactly 100 ETH after sending transactions.

### Synthetic valuations

Use fixed demo rates: ETH=$2,000; POL=$0.50; BNB=$300; HYPE=$10; SOL=$100; BTC=$40,000; dUSDC/dDAI and Arc test USDC=$1; EWLT/sEWLT=$0.10. These are invented educational values, not historical/current prices. Unpriced assets stay unpriced; do not treat them as worth zero when presenting a complete portfolio valuation. Show a partial-value indication.

## 4. Seed transaction scenarios

After deployments and opening allocations, execute the following scenarios with real local node transactions. Record their actual hashes/signatures, fees, receipts, logs and resulting balances.

| Scenario ID | Action | Expected verifiable result |
|---|---|---|
| SEED-01 | Alice sends 0.10 ETH to Bob | Successful native outgoing/incoming activity |
| SEED-02 | Bob sends 125 dUSDC to Alice | Exact 6-decimal token balance changes |
| SEED-03 | Alice sends 0.000000000000000001 EWLT to Carol | One base-unit transfer retained without rounding to zero |
| SEED-04 | Alice transfers ERC-721 #102 to Bob and two units of ERC-1155 #1 to Carol | Ownership/quantity updates and NFT history |
| SEED-05 | Alice calls faucet, then repeats before cooldown | First succeeds; second simulation/revert handled accurately |
| SEED-06 | Alice creates three 100-dUSDC vault positions: two 60-second and one 1-hour | Advance local EVM time 61 seconds; withdraw one short position, leave one withdrawable and one locked |
| SEED-07 | Alice swaps 100 dUSDC to dDAI | Real approval/swap receipts, correct reserves, actual output and fees |
| SEED-08 | Fund shared wallet with 1 ETH and 1,000 dUSDC | Actual contract holdings |
| SEED-09 | Proposal A pays 50 dUSDC to Bob with Alice approval only; proposal B pays 25 dUSDC to Carol with Alice/Bob approvals and execution | Pending versus executed two-owner examples |
| SEED-10 | Alice locks 25 dUSDC on EVM A; demo relayer mints bdUSDC on EVM B | Two real local transactions linked by one simulation message ID |
| SEED-11 | Alice sends 1 SOL and 12.345678 dUSDC to Bob; send to a fresh recipient ATA in a separate transaction | SOL/SPL transfer and account-creation fee coverage |
| SEED-12 | Bob transfers Campus Pass #2 to Alice | Real Solana NFT ownership change |
| SEED-13 | Alice P2WPKH sends 0.01 BTC to Bob; Alice P2TR sends 0.02 BTC to Carol; mine six blocks | Both script types, change outputs, fees and confirmation history |
| SEED-14 | Create an exact ERC-20 allowance and SPL delegate for demo spenders | Permissions screen has real revocable authorizations |
| SEED-15 | Serve malformed/broken/oversized metadata and same-symbol fixtures | Safe fallback and explicit unverified/unsupported states |

Use a fixed local EVM starting timestamp, `2026-11-13T12:00:00Z`, and record time advances in the manifest. Display chain-based remaining vault time; do not use the user's wall clock to authorize withdrawal. Time manipulation is permitted only on verified local nodes. Never call it on public testnets.

Pending, replacement, reorg, RPC outage and relayer-timeout scenarios run on demand through `pnpm scenario -- <name>` against an isolated local test namespace/snapshot. Do not leave the default demo paused or broken. For EVM pending states pause automining only in that scenario, then restore it in a `finally` cleanup. Obtain a real reverted receipt by intentionally broadcasting a known-reverting fixture transaction with an explicit gas limit; separately test preflight rejection without broadcast.

Reorg tests compare block hashes/log removal after controlled local rollback; they do not insert fake receipts into the history database. Bitcoin pending tests leave a real transaction unmined; double-spend tests use isolated chains. Solana expiry tests use an actually expired blockhash or a controlled RPC fixture labelled as such. Distinguish mocked fault injection from real node observations in test reports.

## 5. Seed orchestration, idempotency and safe reset

Implement `scripts/seed-local.ts` as a staged orchestrator:

1. Validate local-only configuration, hostname, chain IDs/genesis identities, project volume ownership and seed schema version.
2. Start/probe nodes and backend; create required public watch configuration.
3. Derive test public identities and create ignored test-only signer files.
4. Deploy/reconcile contracts and Solana programs/mints; import Bitcoin public descriptors.
5. Apply opening allocations and real scenario transactions in dependency order.
6. Rebuild/index public activity, compare balances and produce a public seed manifest.
7. Run assertions and finish with a compact summary of actual results and safe local demo instructions.

Keep `.local/seed-journal.json` with stage identifiers, intent IDs, expected transaction identifiers, submitted/confirmed state and chain fingerprints. On rerun, resume confirmed stages and reconcile unknown submissions before proceeding. Do not mint twice or redeploy simply because a process crashed after broadcasting. Use the same transaction deduplication principles as the wallet. If a deployment address exists with unexpected bytecode, stop that stage rather than silently trust it.

Partition seed journals by family/network and ledger epoch. Restarting an EVM process must not cause repeated Solana minting or Bitcoin funding on their still-persistent ledgers. A normal seed rerun within one epoch is idempotent; a new ephemeral EVM epoch is an explicit reconstruction with new evidence. Never report old transaction hashes as present in the rebuilt ledger without querying them.

The public output `artifacts/seed/local-manifest.json` contains schemaVersion, runId, seed version, timestamps, node identities, tool versions, public addresses/paths, deployments and code hashes, token metadata, scenarios with transaction IDs, opening/final amounts, synthetic prices, assertions and evidence status. It contains no seed phrase, private key, password, backend session cookie or signed transaction bytes. Schema-validate it and have the UI consume it through a public read-only endpoint.

`pnpm seed:local` is idempotent for the current ledger and seed version. `pnpm reset:local -- --confirm=ewallet-demo` explicitly destroys only this project's local chain/database state and recreates it. Validate named volumes/paths before deletion; do not run global Docker prune, delete arbitrary workspaces, or reset a public network. A fresh checkout/setup should not require a destructive reset. Browser wallet data reset is separate and never automatic during node reset; a changed chain fingerprint invalidates cached history and pending records.

`pnpm seed:assert` verifies actual final balances, supplies, owners, token decimals, pool reserves, vault states, multisig thresholds, bridge consumed IDs, Core descriptors/UTXOs and history reconciliation. A script printing “seed complete” is not sufficient evidence.

## 6. Public-testnet seeding

Generate separate testnet-only identities and public manifests. Obtain gas only through legitimate free faucets/airdrops, respecting limits and human-verification requirements. Do not purchase test tokens, bypass faucet protections or use a real-money wallet. If a faucet requires paid holdings, skip that provider and record the funding blocker. Retry later without pretending the test passed.

For each of the seven EVM profiles, independently verify chain ID, obtain a small test-gas balance, deploy standard demo ERC-20/721/1155 fixtures, mint minimal assets, execute native/token/NFT sends and an approval/revoke, then record actual receipts. Use bounded deployment gas limits and show fee estimates; do not repeatedly redeploy on every test invocation. Sepolia additionally hosts the service-contract demonstration where funded.

For Solana Devnet, request legitimate test SOL, create a standard mint/ATAs and a standard noncompressed NFT with metadata, then test SOL/SPL/NFT send and delegate revoke. Use small allocations and wait for airdrop availability without unbounded retries. Bitcoin evaluation remains local regtest and is labelled accordingly.

`pnpm seed:testnets` outputs each network as `passed`, `failed`, `blocked_funding`, `blocked_rpc` or `not_run`. A local test of the same EVM adapter does not change a blocked public-network row to passed. Persist `artifacts/seed/testnet-manifest.json` separately. Do not cache or publish testnet seed secrets in that file.

## 7. Backend data model and indexing

Use SQLite with foreign keys, WAL, prepared statements and numbered SQL migrations. Do not store financial raw amounts in SQLite floating-point columns; store decimal strings. All queries are parameterized. Store public watch data under the anonymous session scope from file 02.

| Table | Key data and constraints |
|---|---|
| `sessions` | Token hash, CSRF binding, expiry; no passwords or wallet secrets |
| `watched_accounts` | Session, network, address/public descriptor reference, watch start, discovery indexes |
| `assets` | Unique network/standard/reference/token ID, validated decimals, safe metadata, canonical alias |
| `balance_snapshots` | Account+asset+observation height/hash/time, raw amount, stale state |
| `transactions` | Network+hash unique, block/slot, inclusion hash, status, public sender/recipient, fee |
| `transfers` | Network+transaction+event/instruction/output index unique, asset, amount, from/to |
| `sync_cursors` | Network+watch scope, last complete height/signature, block hash, backfill bounds |
| `contract_events` | Deployment+event identity unique, normalized vault/multisig/swap/bridge payload |
| `metadata_cache` | Canonical asset, safe cached content/hash, fetch status and expiry |
| `notification_receipts` | Session+transaction+state key unique, delivered/read timestamps |
| `schema_migrations` | Applied version/checksum/time |

Keep browser contacts, vault envelope, account labels and dapp grants local. Backend session data only supports public watching/indexing; losing it must not lose control of the wallet. Restrict watch list size and backfill ranges to prevent an unbounded public indexer workload.

### Indexing strategies

- **EVM:** index registered contract logs in bounded block windows. Track normal native transfers by inspecting new block transactions for watched addresses and the wallet's own journal. Start from seed deployment/watch block, not genesis. Include project contract events. Internal native transfers require traces on many chains; if no free trace interface is available, label their history coverage incomplete rather than inventing completeness. Their current balance is still fetched from the node.
- **Solana:** paginate signatures for owner and relevant token accounts; parse supported transaction instructions and token balance deltas; keep cursors and commitment. Reconcile incoming ATA activity and transaction failures. Do not assume every token movement appears solely in the owner's direct signature list.
- **Bitcoin:** use the watch-only wallet/descriptors and chain/mempool observations, identifying inputs, outputs, change, fees and spent outpoints. Support rescans from the configured birthday/height with visible progress.
- **All families:** restart from durable checkpoints; enforce idempotent inserts; compare inclusion block hashes; roll back orphaned events/snapshots and replay; rebuild derived balances from the node. Keep cursor updates and the related event batch in one database transaction.

Polling defaults: active network every 5 seconds, inactive profiles every 30 seconds with global concurrency 3 and exponential rate-limit backoff. Pause unnecessary work when no watch session is active. A refresh timestamp must describe real data freshness, not merely a timer tick. Notifications are emitted once after a state transition and can be updated if a reorg reverses it.

### API contract

Version endpoints under `/api/v1`. Use `{ data, meta }` responses, cursor pagination and `{ error: { code, message, correlationId } }` failures. Use integer strings for quantities; ISO timestamps and explicit network identifiers.

| Endpoint | Purpose |
|---|---|
| `POST /session` | Establish anonymous scoped session and CSRF token |
| `GET /health` | Nonsensitive service/version/readiness status |
| `GET /networks` | Approved profiles and actual health, no credentials |
| `POST /watch` / `DELETE /watch/:id` | Register/remove bounded public address/descriptor watch |
| `GET /balances` | Observed public balances with stale/source metadata |
| `GET /assets` / `GET /collectibles` | Registry/discovered asset data and safe metadata |
| `GET /activity` / `GET /transactions/:network/:hash` | Filtered normalized history and raw public details |
| `GET /contracts/:network/state` | Indexed vault/multisig/pool state reconciled with node reads |
| `POST /rpc/:network` | Strict allowed RPC subset, schema/size/rate validation, fixed upstream |
| `GET /metadata/:assetKey` / `GET /media/:contentHash` | Sanitized metadata and safe cached images |
| `GET /demo/manifest` | Public local seed manifest only when local demo mode is enabled |

No `/sign`, `/private-key`, `/mnemonic`, `/admin/mine` or `/admin/reset` endpoint exists. API failures map to consistent frontend states. Validate authorization to session-scoped data; public blockchain visibility does not justify leaking another user's watchlist or session token.

## 8. Metadata safety and demo media

Store original local PNG/WebP fixture images, metadata JSON and broken-media fixtures in source-controlled nonsecret assets. Use no external copyrighted collections. Metadata fields are length-limited plain text; NFT media is not an iframe or arbitrary HTML. Default to a neutral placeholder until remote media is requested/approved.

The backend metadata fetcher permits HTTPS and a configured IPFS gateway only. Block credentials, private/loopback/link-local/cloud-metadata IPs, non-HTTP schemes and DNS rebinding; resolve and revalidate every redirect, maximum two redirects. The explicit local fixture server is a separate allowlisted source, not a general exception for arbitrary private URLs. Limit JSON to 256KB, image downloads to 5MB, timeout to 5 seconds, and decoded dimensions to 4096×4096. Sniff content type, reject HTML/SVG/active content and re-encode raster images with a pinned image library before serving them with safe headers. Reject decompression bombs. Do not fetch `animation_url` automatically.

Remote media can reveal an address/IP relationship. Provide a setting to block it and prefer locally cached safe content. A failed metadata fetch never blocks access to the token's raw identifier/balance or prevents a supported transfer.

## 9. Web-wallet connector protocol

Implement this explicitly because the project is a website, not an injected extension. `packages/provider` exports `createEWalletConnector({ walletUrl })`. The reference dapp includes the connector; other sites must integrate it themselves. Do not imitate `isPhantom`, claim to be MetaMask or overwrite another wallet's provider.

### Transport and approval window

1. A user clicks Connect in the dapp. Generate a cryptographically random channel nonce and request ID. Open the approved wallet URL `/connect#channel=<nonce>` directly within that click so browsers allow the popup. Put no transaction, address list, phrase or signature in the URL.
2. Keep the returned window reference. The SDK accepts replies only when `event.source` is that window, `event.origin` exactly matches the configured wallet origin, and the channel/version/request IDs match. Always send with an exact `targetOrigin`, never `*`.
3. The wallet connection page validates opener/message source and actual browser-reported origin. It displays that exact origin, requested accounts, network and methods. Do not trust a dapp-supplied display name as its identity. Deny opaque/null origins and cross-origin iframes; reference flow is top-level only.
4. Bind the consent to origin, account set, network, allowed methods, expiry and channel. Connection grants expire after 24 hours by default; lock prevents signing even with a grant. Returning addresses needs a connection grant; each signing/send request still needs approval.
5. After explicit approval and unlock where required, route the typed request through wallet-core and return only the approved public result. Close/cancel/navigation/timeout rejects the pending request. Invalidate a channel when its origin/window changes; do not replay a previous approval.
6. Requests expire after two minutes while awaiting a human; prepared transaction previews still have their shorter chain/quote expiry. Limit to one active signing request per connection and five queued requests; reject flooding/oversized messages.

Persist only grant metadata and public request IDs, not pending approval tokens. A wallet refresh requires a fresh channel handshake and any affected operation to be reviewed again. The SDK reopens the approval window from a user gesture for a new signing action; it cannot assume a previously closed window can be reopened without popup restrictions. If blocked, show an explicit “Open wallet approval” button. Support manually opening the same window as a tab; do not introduce an insecure unbound redirect fallback.

Set connection-page response headers deliberately: `/connect` must preserve the intentional opener relationship (`Cross-Origin-Opener-Policy: unsafe-none` for that route), while normal wallet pages can use stronger opener isolation. The reference dapp uses an opener policy compatible with this flow. Keep `frame-ancestors 'none'` and strict CSP on the connection page. Test actual popup/postMessage behavior in the built deployment, not only jsdom.

### Family interfaces

| Interface | Required methods and boundaries |
|---|---|
| EVM connector | EIP-1193 `request`, event registration; `eth_requestAccounts`, permission-filtered `eth_accounts`, `eth_chainId`, approved `wallet_switchEthereumChain`, `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4` |
| Solana connector | Wallet Standard registration within the integrating dapp; connect/disconnect/events, signMessage, signTransaction, signAndSendTransaction for supported messages |
| Bitcoin connector | Documented project API `getAccounts`, `getNetwork`, `signPsbt`, `broadcastTransaction`, disconnect; do not call it a universal Bitcoin standard |

EVM typed signatures must display domain name/version, chainId, verifying contract and structured message. Reject mismatched domain chains, raw `eth_sign`, unsupported selectors and arbitrary chain addition. Personal messages show readable text or hex plus size/domain context and cannot be mislabeled “login” without verification. Limit messages to 16KB. Return conventional EIP-1193 errors for rejection/unauthorized/unsupported/disconnected states.

Solana signed transactions must have the authorized fee payer/signers and fully decoded supported instructions. The Bitcoin API uses PSBT validation from file 03; dapps cannot hide recipient outputs as change or request arbitrary sighash flags. A signed PSBT response is sensitive authorization data; return it only to its bound requesting window/origin, with no telemetry.

Build reference dapp tabs for each family: connect, display selected public accounts/network, request a message signature where supported, prepare a small transfer, show approval/rejection, inspect receipt and disconnect. Add controlled malicious cases for wrong origin/channel/network, tampered payload, repeated request ID and unknown method. These controls are confined to the development/reference app.

## 10. Grants and on-chain revocation

Connected-app grants and token authorizations are different concepts. Disconnect removes the local connection grant and emits account/disconnect changes; it cannot undo already signed transactions or automatically reset on-chain allowances.

List tracked ERC-20 approvals by chain/token/spender and their current on-chain amount; revoke with `approve(spender, 0)` and a normal transaction review. Include ERC-721/1155 operator approvals if granted by supported flows; revoke with the appropriate standard method. SPL revoke uses the supported token account/program and explicit signature. Bitcoin displays “approval required for every signing request”; there is no invented on-chain disconnect operation. Unknown historical approvals outside the indexed range must be labelled as possibly incomplete.

## 11. Tasks and phase gate

| Task | Deliverable | Proof |
|---|---|---|
| D01 | Pinned infrastructure and preflight scripts | Clean nodes start, loopback binding and version manifest |
| D02 | Deterministic seed identities, allocations and deployments | No private fields in public manifest; real node balances |
| D03 | Seed scenarios and idempotent resume | Rerun changes no balances/supply; crash recovery does not duplicate sends |
| D04 | SQLite schema/indexers and public APIs | Restart/backfill/reorg/reconciliation tests |
| D05 | Safe metadata pipeline and fixture gallery | Malicious URI/content rejected, ownership still usable |
| D06 | Web popup connector and all three reference flows | Real browser cross-origin approvals and origin-binding tests |
| D07 | Grants, allowance/delegate revoke and notifications | Real revocation receipts and no duplicated success alerts |
| D08 | Public-testnet seed runner and evidence report | Per-network actual results with funding/RPC blockers preserved |

Commands: `pnpm seed:local`, `pnpm seed:assert`, `pnpm seed:testnets`, `pnpm dev`, `pnpm scenario -- pending-evm`, `pnpm test:integration`, `pnpm test:dapp`. `dev` starts wallet/backend/reference dapp and uses existing healthy nodes; it does not reset or silently reseed them.

**Gate G4:** a clean local setup produces the documented on-chain dataset; rerunning seed is safe; all three-family reference dapps connect through the web-wallet approval window; history survives restart and reconciles with nodes; revoke changes chain state; no seed administration endpoint is public; public network blockers remain accurately labelled. Save evidence under `artifacts/phase-04/`.

Next: [05_TESTING_RELEASE_AND_HANDOVER.md](05_TESTING_RELEASE_AND_HANDOVER.md).

## 12. Primary references

- [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193): EVM connector request/events/error interface. The popup transport is our project design, not part of that EIP.
- [Wallet Standard Solana extensions](https://github.com/wallet-standard/wallet-standard/blob/master/extensions/solana.md): supported connector feature names.
- [Metaplex Token Metadata](https://github.com/metaplex-foundation/mpl-token-metadata): program/source/client compatibility.
- [Bitcoin regtest examples](https://developer.bitcoin.org/examples/testing.html): isolated mining/test environment.
- [Window.postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage): exact origin/source validation for browser messaging.
