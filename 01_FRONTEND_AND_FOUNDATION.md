# 01 — Frontend and project foundation

**Project:** e-wallet · **Plan version:** 1.0 · **Prepared:** 13 November 2026  
**Execution order:** 01 → 02 → 03 → 04 → 05. These five files are one implementation specification. Start with this file, read the interface and dependency sections of the others, then implement each phase in order.

## 1. Instructions to the implementing Codex agent

Build the application, not another proposal. Make routine implementation decisions yourself within this specification. Do not ask the student to choose a framework, database, layout, hosting provider, or blockchain library. Preserve working code and user changes; inspect the repository and applicable `AGENTS.md` instructions before editing. If the directory is empty, scaffold the structure below. If it already contains e-wallet, map existing code to this architecture and migrate incrementally; do not delete it to make the tree look identical.

Complete each phase's implementation and verification gate before claiming that phase is complete. Continue to the next file when it is available. If a tool, faucet, network, or dependency is unavailable, finish independent work and record the precise blocker and reproduction command. Never substitute screenshots, mocked balances, or a network dropdown for working blockchain support. Do not silently narrow the required scope.

Maintain `implementation-status.json` at the repository root with phase, task ID, state (`not_started`, `in_progress`, `passed`, `failed`, `blocked`), changed paths, actual check results, evidence paths, and remaining blockers. Record significant compatibility choices in `decisions.json`. These are machine-readable work records, not extra planning Markdown files. Do not mark checks as passed unless you ran them. Do not push, publish, buy services, or register paid accounts as part of this implementation.

## 2. Product and scope decisions

Create an original, self-custody, Phantom-inspired **browser-based website** named **e-wallet**, with a responsive wallet dashboard and a separate reference dapp. The user's latest instruction is authoritative: **no browser extension, mobile app, desktop app, or installable application is part of this project**. The user controls the recovery phrase and signing keys in their browser. There is no email login, hosted custody account, or server-side user-wallet signer. Use established cryptographic libraries; “from scratch” refers to our application, interface, adapter integration, contracts, and tests, not inventing cryptography.

Users open the wallet URL in an ordinary browser. Node services and blockchain containers are development/server infrastructure, not apps the wallet user installs. The required evaluation deployment runs at localhost and is completely free. The same frontend/backend can be served over HTTPS on university-owned infrastructure. Do not add a paid hosting dependency, a PWA installation flow, an extension manifest, or app-store packaging.

The assessed release runs on **local chains and public testnets only**. Every screen identifies its mode and network. Use original branding, icons, copy, and assets; do not copy Phantom's source or pretend the product is Phantom. Use real local blockchain transactions for transfers, swaps, and contract demonstrations. The bridge remains an explicitly labelled educational simulation.

### Frozen network scope

The current Phantom network list was checked on 13 November 2026. Implement these nine network families; do not dynamically expand the project whenever Phantom changes its offering.

| Network family | Evaluation environment | Fee currency | Required assets |
|---|---|---|---|
| Ethereum | Sepolia; local EVM for repeatable tests | ETH | Native, ERC-20, ERC-721, ERC-1155 |
| Base | Base Sepolia | ETH | Same EVM standards |
| Polygon | Amoy | POL | Same EVM standards |
| BNB Chain | BSC Testnet | Test BNB | ERC-20-compatible/BEP-20, ERC-721, ERC-1155 |
| HyperEVM | HyperEVM Testnet | HYPE | Same EVM standards |
| Robinhood Chain | Robinhood Chain Testnet | ETH | Same EVM standards |
| Arc | Arc Testnet | USDC | Native USDC plus supported EVM standards |
| Solana | Local validator and Devnet | SOL | Standard SPL tokens and standard noncompressed NFTs |
| Bitcoin | Bitcoin Core regtest | BTC | Native SegWit and Taproot BTC |

All seven EVM networks use a common adapter with separate verified configurations. Solana and Bitcoin use their own adapters and signing formats. An Ethereum smart contract cannot control balances on another blockchain. “All tokens” means compatible standards on these networks, including custom token import; it does not mean every token, unusual contract behavior, or future token extension is supported.

Implement basic Token-2022 fungible tokens only after parsing their extension set; reject unsupported extensions explicitly. Mandatory Solana transfer/NFT acceptance uses the standard Token Program. Exclude compressed NFTs, programmable NFTs, transfer-hook/confidential tokens, Bitcoin inscriptions/Runes/BRC-20, hardware wallets, social recovery, staking, fiat payments, leverage/perpetuals, production bridge relayers, mobile apps, and app-store publishing. These are stated compatibility boundaries, not hidden unfinished screens.

### Ten requirements retained from the project plan

| Requirement | Delivered behavior |
|---|---|
| R01 Wallet lifecycle | Create/import, recovery backup, encrypted storage, multiple derived accounts, password change, lock/unlock |
| R02 Multi-chain | Seven EVM configurations, Solana adapter, Bitcoin P2WPKH/P2TR adapter |
| R03 Portfolio | Exact balances, aggregate demo valuation, token import/discovery, hidden/spam assets |
| R04 Payments | Receive/QR/contacts, fee and recipient preview, local signing, broadcast and reconciliation |
| R05 Activity | Incoming/outgoing history, filters, receipts, local details/explorers, deduplicated notifications |
| R06 NFTs | EVM and supported Solana ownership, gallery, metadata safety, transfer |
| R07 App connections | Web-wallet connector with EVM provider interface, Solana Wallet Standard connector, Bitcoin reference PSBT API, permissions/revocation |
| R08 Swap and bridge | Real local test-token AMM swap; labelled two-local-chain bridge simulation |
| R09 Contract services | Test faucet, time-locked savings vault, two-of-three shared wallet |
| R10 Delivery | Seed scripts, automated checks, network evidence, clean setup, evaluation package |

## 3. Selected stack

| Layer | Decision | Reason |
|---|---|---|
| Runtime/package management | Node.js 24 LTS; pnpm 10 workspaces; TypeScript strict | One language across application, scripts, and local service |
| Web application | Vite 8 with the compatible React plugin, standard browser website, no SSR | Simple static frontend, browser-only signing and reproducible builds |
| Interface | React 19, Tailwind CSS 4, Radix primitives, Lucide icons | Accessible controls and an original reusable visual system |
| Routing/state | React Router 7 browser routing; TanStack Query 5; Zustand 5 for nonsensitive UI state | Responsive routes, server-state caching, small local UI state |
| Forms/validation | React Hook Form and Zod | Shared validation with typed runtime boundaries |
| EVM | ethers 6 | Big-integer unit helpers, transactions, ABI encoding |
| Contracts | Solidity 0.8.30; OpenZeppelin Contracts 5; Hardhat 3 with the official Mocha/Ethers toolbox | Local EVM, established contract primitives, deterministic tests |
| Solana | `@solana/kit`, compatible official `@solana-program/*` clients, Wallet Standard packages | Current official SDK and explicit program instructions |
| Bitcoin | bitcoinjs-lib 7, bip32, ecpair, tiny-secp256k1 | PSBT, P2WPKH, P2TR and vetted curve implementation |
| Seed/key derivation | `@scure/bip39`, `@scure/bip32`, `micro-key-producer` SLIP-0010 implementation | Standard derivation, no handwritten curve math |
| Encryption | Browser Web Crypto PBKDF2 and AES-GCM | Native browser cryptographic operations |
| Backend | Fastify 5, SQLite through better-sqlite3, SQL migrations | Watch-only indexing, browser-compatible RPC access and repeatable local evaluation |
| Local chains | Two Hardhat nodes, Solana test validator, Bitcoin Core regtest | Free, controllable fixtures across three chain architectures |
| Tests | Vitest, React Testing Library, Playwright, Hardhat tests, fast-check | Unit, web browser, contract, integration and invariant coverage |
| Development environment | Linux or WSL2; Docker Engine + Compose plugin | Free local orchestration; no Docker Desktop subscription required |

Resolve compatible patched releases within these selected major versions, pin exact versions in `package.json`/lockfile, and record Node, pnpm, compiler, native tools and container digests in `toolchain-lock.json`. Check official release documentation and security notices before installing. Do not use floating `latest` container tags or copy obsolete SDK APIs. If the chosen compiler has a relevant advisory, select a fixed compatible 0.8.x patch and record why. Compile contracts with `evmVersion: "paris"` unless a tested dependency requires a documented change; do not assume every target supports the newest opcodes.

Disable Vite browser-console forwarding and integrated devtools for real-wallet development, and never log sensitive values. Development conveniences must not forward recovery inputs or signing internals to an agent/terminal. Keep the ordinary mock UI workflow available without any secrets.

Solana's current documentation recommends Kit; do not mix legacy `@solana/spl-token`/web3.js 1.x objects with Kit transactions. Use a small isolated conversion adapter only if an NFT metadata client requires it, with serialization tests. Prefer program clients compatible with Kit.

Everything required must run without subscriptions, API keys, or card details. Initial open-source package downloads require internet. Public faucet availability is not guaranteed; local evaluation must remain fully usable without it. Do not add Firebase, Supabase, Moralis, Alchemy-only indexing, WalletConnect cloud, a live price API, or a hosted database as required dependencies. Optional free CI uses the same local commands.

## 4. Repository and responsibility boundaries

Create the following packages; the listed paths are directories, not generated planning documents:

| Path | Responsibility |
|---|---|
| `apps/wallet` | Vite web wallet, routes, dedicated signing Web Worker and web approval window |
| `apps/reference-dapp` | Three-family connection/signing test application |
| `services/backend` | Watch-only indexing, history API, safe metadata, restricted RPC boundary and static hosting |
| `packages/ui` | Tokens, components, screen compositions and accessibility helpers |
| `packages/domain` | Zod schemas, IDs, amounts, errors, requests and adapter interfaces |
| `packages/wallet-core` | Vault encryption, derivation, lock state, trusted approval and signing |
| `packages/chain-evm` | EVM RPC, balances, preparation, fees, receipts and decoding |
| `packages/chain-solana` | Solana RPC, accounts, instructions, fees and confirmation |
| `packages/chain-bitcoin` | Public derivation, UTXOs, PSBT preparation/validation and tracking |
| `packages/provider` | Web-wallet popup transport, EIP-1193 connector, Wallet Standard connector, reference Bitcoin API |
| `packages/config` | Versioned network profiles and supported asset registry |
| `contracts` | Solidity source, tests, deployment and ABI generation |
| `scripts` | Health checks, infrastructure, seeding, verification, packaging |
| `fixtures` | Mock UI scenarios, public test vectors, synthetic metadata |
| `infra` | Compose configuration and pinned node/container build recipes |
| `tests` | Cross-package integration and web-wallet end-to-end tests |
| `artifacts` | Generated manifests, evidence, screenshots and reports; no secrets |
| `.local` | Ignored local state, node data, test-only secret files and pairing token |

Enforce import boundaries: React components and reference dapp packages cannot import secret derivation/signing code; backend cannot import a user-wallet signer. Chain preparation adapters receive public account information. Only wallet-core inside the wallet's dedicated Web Worker may obtain a user's derived private key. This reduces accidental secret exposure; it is not a claim that a Worker defeats same-origin malicious JavaScript.

### Architecture and data flow

1. React screens send typed requests to a `WalletGateway` abstraction.
2. Phase 1 binds it to `MockWalletGateway`; real builds bind it to typed Web Worker messages and read-only API clients.
3. The wallet host and Worker validate request schemas, permissions, network identity and approval state. A separate web-wallet connection broker validates cross-origin dapp messages.
4. Chain adapters prepare unsigned operations and query public blockchain data.
5. A wallet-origin approval page presents the exact operation; wallet-core signs after approval.
6. The Worker broadcasts through the approved adapter and persists transaction tracking data. The backend observes public data and never receives a recovery phrase, private key or password.

A website cannot inject a wallet into arbitrary other websites like an extension. Therefore supply an explicit e-wallet connector SDK: the reference dapp opens our wallet in a separate approval window, exchanges origin-bound messages, and receives only approved public results/signatures. EIP-1193 and Wallet Standard interfaces are implemented by that connector within an integrating dapp. Do not claim universal automatic discovery or compatibility with dapps that have not integrated the connector. No paid relay or WalletConnect project is required.

Use mock, local, and public-testnet modes as distinct configurations and data namespaces. There is no mainnet toggle in the assessed build. A mocked result must carry `source: "fixture"`; a node-backed result includes network ID, observation block/slot and time. Never merge mocked holdings into a node-backed portfolio.

## 5. Shared types to establish before building screens

Define and export runtime schemas as well as TypeScript types:

| Type | Minimum fields and invariants |
|---|---|
| `NetworkProfile` | `id`, family, environment, chain ID or genesis identity, RPCs, fee asset, explorer, enabled capabilities, finality policy |
| `AccountRef` | ID, root-wallet ID, family, public address, derivation path, account/index metadata; no secret |
| `AssetId` | Canonical network ID + standard + normalized contract/mint + optional token ID; native has an explicit sentinel |
| `AssetBalance` | Asset ID, raw integer decimal string, decimals, available/reserved amounts, source, observed height/time |
| `PortfolioValue` | Integer micro-USD plus `priceSource: "demo"`, rate timestamp, and missing-price count |
| `TransactionIntent` | Request ID, account, network, operation kind, recipient, asset, integer amount, origin if applicable |
| `PreparedOperation` | Immutable encoded payload, structured preview, fee breakdown, expiry, state fingerprint and digest |
| `ApprovalRequest` | Request ID, trusted sender context, payload digest, account/network, creation and expiry times |
| `TransactionRecord` | Local ID, network, hash/signature, intent, state, block/slot, fee, replacement/reorg data |
| `Collectible` | Network/standard/contract or mint/token ID, quantity, safe metadata status, ownership observation |
| `AppPermission` | Origin, family, network scope, selected accounts, methods, creation/expiry, revoked state |
| `AppError` | Stable code, safe user message, retryability, public diagnostic correlation ID |

Amounts use `bigint` internally and decimal strings across JSON/storage/message boundaries. Human input is a decimal string, never a JS `number`. Reject exponent notation, negatives, NaN, Infinity and excessive fractional digits. Quantity and fees must not pass through floating-point arithmetic. Distinguish an unknown/stale balance from zero. Preserve raw amounts for tooltips and transaction details.

Define `WalletGateway` operations for lifecycle, account selection, balances, token import/hide, receive request, prepare/approve/reject transaction, activity, NFTs, permissions, swaps, faucet, vault and shared wallet. In phase 1 implement only the mock gateway and schemas; reserve background method contracts for phase 2. Do not place temporary signing code in components.

## 6. Frontend design and screen inventory

Use an original dark navy interface: background `#0B1020`, surfaces `#151D31`, primary mint `#76E0C4`, secondary lavender `#B5A4FF`, text `#F4F7FF`, muted `#AAB6CE`, warning amber and danger red. Verify actual contrast for each component. Use system fonts so the app does not require a font CDN. Add light mode only after the mandatory dark mode works; it is not a delivery blocker.

Responsive targets: 360px mobile browser, 768px tablet, and 1440px desktop, with support down to 320px. Use a navigation sidebar on desktop and bottom navigation on narrow screens. The web approval window targets 460 × 720 CSS pixels and must also work as a normal browser tab. Use tabs for Assets, Collectibles, Activity, and Apps; provide visible Send, Receive, Swap and Contract Services actions. Network and account selection stay visible. Use human-readable words rather than raw RPC errors.

| Screen/group | Required content and behavior |
|---|---|
| Welcome | Create/import choices, concise self-custody explanation, permanent test-mode indicator |
| Create wallet | Password/confirmation, strength guidance, recovery reveal, backup acknowledgement and randomized word check |
| Import wallet | 12/24-word input, checksum errors, optional BIP39 passphrase advanced field, password setup |
| Lock/recovery | Unlock, lock reason, restore guidance; no pretend password-reset email |
| Home | Total demo value, per-network holdings, amount visibility, last refresh/stale indicator |
| Account/network menus | Derived accounts, add/rename, family addresses, enabled network profiles, connection state |
| Asset details | Exact balance, identifier, decimals, network, incoming/outgoing activity, hide/unhide |
| Token management | Registry search, custom contract/mint import, explicit metadata review, hidden/spam list |
| Send | Asset/network, recipient/contact/QR, amount/max, fee estimate, review, submitting and receipt states |
| Receive | Correct family address and network, QR, copy, optional amount request; Bitcoin address type selection |
| Contacts | Create/edit/delete labels and network-bound addresses; never treat an address as proof of a network |
| Activity | Filters by account/network/status/type, paginated list, full transaction details and explorer/local details |
| Collectibles | Gallery, ownership/quantity, safe fallback image, details and transfer review |
| Connected apps | Origin, accounts/networks, permissions, disconnect; token allowance/delegate list and revoke action |
| Approval window | Plain origin, account/network, recipient, amounts, fee, decoded operation and risk information |
| Swap | Local demo pair, quote, minimum output, slippage, allowance stage, expiry, transaction receipt |
| Bridge simulation | Prominent simulation banner, local source/destination, lock/mint stages, timeout/retry state |
| Faucet | Local test assets, cooldown/quota, request/receipt; separate public faucet links |
| Savings vault | Deposit amount/duration, position list, chain-based unlock time, withdraw review |
| Shared wallet | Three owners, threshold, holdings, create proposal, approve/revoke/execute and timeline |
| Settings | Autolock, password change, secure backup/reveal, active networks, RPC diagnostics, data export and reset |
| Evaluation panel | Fixture/local/testnet status, seed manifest ID, network health, feature evidence links |

The ordinary wallet UI must remain understandable. Put RPC URLs, deployment hashes and seed diagnostics in Settings/Evaluation, not on every customer-facing card. Keep the test/simulation and network labels where they affect interpretation.

All interactive controls need keyboard access, visible focus, accessible names, properly associated errors, and focus-trapped dialogs. Set touch targets to at least 44px where practical. Avoid color-only state distinctions. Long addresses must wrap or truncate with a safe full-address view; never truncate the recipient on the final review. Use reduced-motion preferences.

For QR, package a free encoder/decoder locally. Support text paste and uploaded QR image in the mandatory version; camera scanning is optional, so no camera permission is required for the baseline. Parse payloads as data and require network/amount review. Never auto-submit after scanning.

## 7. Frontend-first task sequence

| Task | Work | Completion evidence |
|---|---|---|
| F01 | Inspect repository, scaffold workspaces, lint/typecheck/configure aliases and boundaries | Clean installation; script inventory; exact dependency lock |
| F02 | Create domain schemas, amount helpers and gateway contracts | Boundary/amount tests and sample serialized payloads |
| F03 | Implement theme, reusable fields, dialogs, tables, amount/address display and navigation | Component interactions and responsive screenshots |
| F04 | Implement onboarding, lock, account/network selection and recovery mock flows | Complete keyboard walkthrough without blockchain services |
| F05 | Build portfolio, tokens, send/receive/QR, contacts and activity | Every primary action reaches an implemented mock state |
| F06 | Build collectibles, app approvals, permissions, swap/bridge and contract service screens | All workflows navigable, including rejection/error paths |
| F07 | Implement settings and evaluation panel; mock scenario picker only in preview/development | State matrix verified; no preview controls in release bundle |
| F08 | Build responsive wallet routes and `/connect` approval page using shared components | Website runs in a normal browser; connection UI works as window or tab |
| F09 | Verify frontend gate and update work records | Actual screenshots, accessibility results and phase status |

Mock data must cover: populated wallet, empty wallet, loading, disconnected RPC, stale balances, hidden/spam token, excessive amount, wrong network, low fee balance, user rejection, pending/confirmed/reverted transaction, NFT missing media, expired quote, locked vault and multisig one/two approvals. Use original local artwork. Do not use an external wallet connection as a substitute for implementing our wallet.

Mock onboarding uses clearly designated sample data only. The mock build must prominently prohibit real recovery phrases and avoid persisting secret inputs; real onboarding is implemented in the browser wallet in phase 2. Make the preview's sample phrase a non-secret fixture and keep sample credentials out of normal release bundles.

## 8. Commands and phase gate

Provide root scripts with stable names. Commands listed for later files are implementation targets, not claims that they already exist.

```sh
pnpm install
pnpm dev:ui
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build:web
```

`dev:ui` serves the mock wallet website on `127.0.0.1:5173`. `build:web` creates static website assets under `apps/wallet/dist`; release verification uses the built site served by Fastify with SPA fallback and security headers. Phase 2 adds `dev:wallet` for real browser-wallet mode. Keep mock mode and real mode explicit at build/configuration boundaries.

**Gate G1:** all screens above exist; navigation/actions and mock state transitions work; no signing keys or real funds are involved; typecheck/lint/unit checks pass; the built website opens directly and on nested routes; screenshots at 320px, 360px, tablet and desktop widths show no clipping; keyboard onboarding/send/approval flows work. Save evidence under `artifacts/phase-01/`. Do not mark R01–R10 complete just because their screens are implemented.

Next: [02_WALLET_CORE_AND_SECURITY.md](02_WALLET_CORE_AND_SECURITY.md).

## 9. Primary references and interpretation

- [Phantom supported networks](https://help.phantom.com/articles/41372840389651): source for the frozen nine-network list, not a promise to reproduce every Phantom product feature.
- [Node release schedule](https://nodejs.org/en/about/previous-releases): Node 24 LTS selection.
- [Vite documentation](https://vite.dev/guide/), [Vite 8 release](https://vite.dev/blog/announcing-vite8) and [React documentation](https://react.dev/learn).
- [Solana official JavaScript SDK](https://solana.com/docs/clients/official/javascript): Kit and compatible program clients.
- [Hardhat 3 getting started](https://hardhat.org/docs/getting-started) and [Mocha/Ethers toolbox](https://hardhat.org/docs/plugins/hardhat-toolbox-mocha-ethers).

The architecture, interface, task ordering and acceptance gates are project decisions. Network endpoints and library compatibility must be rechecked when implementation begins; update configuration with evidence rather than inventing successful connectivity.
