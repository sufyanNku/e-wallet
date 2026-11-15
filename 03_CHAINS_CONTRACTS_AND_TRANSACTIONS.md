# 03 — Blockchain adapters, transactions and smart contracts

**Prerequisite:** Gate G2 in [02_WALLET_CORE_AND_SECURITY.md](02_WALLET_CORE_AND_SECURITY.md).  
**Outcome:** the web wallet signs and executes supported operations against real local nodes, with separately configured public-testnet adapters. Phase 4 makes the full dataset reproducible and completes indexing/dapp integration.

## 1. Adapter contract and execution order

Implement EVM first, then Solana, then Bitcoin. Build the common portfolio/payment UI against the adapter interface rather than one blockchain's response objects. Start each adapter with a minimal node and two funded test accounts; the comprehensive resettable seed suite belongs to phase 4.

Each adapter exposes public methods for health/network identity, address validation, balances, supported-asset discovery, fee estimation, unsigned operation preparation, simulation where available, signed-payload broadcast, status reconciliation and explorer/local detail construction. Private signing stays in the browser Worker. Provide family-specific prepared-operation schemas rather than weakening everything to `any`.

Every network read returns source, timestamp and block/slot information. Every prepared operation binds the active network and account. Read-only fallback RPCs must verify the same network identity before use. Prefer one pinned endpoint for a transaction lifecycle; never merge contradictory observations as if they were one authoritative response. Surface stale/unavailable data.

The backend may proxy an explicit list of RPC methods to configured endpoints when browser CORS prevents direct access. It cannot receive arbitrary destination URLs, private keys, arbitrary admin methods or signer requests. Bitcoin Core is accessed only through this restricted backend boundary.

## 2. Network configuration

Use the following initial profiles. These values were checked against current primary network documentation where available; probe them again during implementation. Public endpoints are best-effort and may be rate-limited. Alternative endpoints require the same chain/genesis identity and must be recorded in configuration.

| Application network ID | Environment | Identity | Initial RPC | Explorer base |
|---|---|---|---|---|
| `eip155:31337` | Local EVM A | Chain ID 31337 | `http://127.0.0.1:8545` | Local transaction detail page |
| `eip155:31338` | Local EVM B, bridge simulation | Chain ID 31338 | `http://127.0.0.1:8546` | Local transaction detail page |
| `eip155:11155111` | Ethereum Sepolia | 11155111 | `https://ethereum-sepolia-rpc.publicnode.com` | `https://sepolia.etherscan.io` |
| `eip155:84532` | Base Sepolia | 84532 | `https://sepolia.base.org` | `https://sepolia.basescan.org` |
| `eip155:80002` | Polygon Amoy | 80002 | `https://rpc-amoy.polygon.technology` | `https://amoy.polygonscan.com` |
| `eip155:97` | BSC Testnet | 97 | `https://bsc-testnet.bnbchain.org` | `https://testnet.bscscan.com` |
| `eip155:998` | HyperEVM Testnet | 998 | `https://rpc.hyperliquid-testnet.xyz/evm` | Built-in transaction details; no default external explorer |
| `eip155:46630` | Robinhood Chain Testnet | 46630 | `https://rpc.testnet.chain.robinhood.com` | `https://explorer.testnet.chain.robinhood.com` |
| `eip155:5042002` | Arc Testnet | 5042002 | `https://rpc.testnet.arc.io` | `https://explorer.testnet.arc.io` |
| `solana:local` | Local validator | Genesis hash recorded at boot | `http://127.0.0.1:8899` | Local transaction detail page |
| `solana:devnet` | Solana Devnet | Verify Devnet genesis hash | `https://api.devnet.solana.com` | `https://explorer.solana.com`, append `cluster=devnet` |
| `bitcoin:regtest` | Bitcoin Core regtest | Verify regtest chain/genesis | Backend adapter; Core internal RPC port 18443 | Local transaction detail page |

The Solana/Bitcoin IDs above are application IDs, not claims of canonical CAIP identifiers. Store full observed genesis hashes separately. Local nodes are development environments, not additional supported Phantom networks. Running seven locally renamed EVM nodes would not prove seven-network compatibility.

`NetworkProfile` also stores native asset precision, RPC timeout, log-range limit, supported fee mode, confirmation policy, deployment manifest reference, enabled standards and verified date. Health checks query actual chain ID/genesis and reject a mismatched endpoint before any signature. Free endpoints/faucets are replaceable operational configuration, not source-code constants scattered across components.

### Native currency and precision rules

- ETH, POL, BNB and HYPE use 18-decimal EVM native units. SOL uses 9; BTC uses 8.
- Arc uses USDC for native gas accounting at 18 decimals and an ERC-20 view at 6 decimals of the same underlying balance. Model these as representations of one canonical asset, not two holdings. Verify the system contract address from Arc's current contract-address documentation; ordinary dUSDC test tokens are separate assets.
- For Arc native value transfers use native 18-decimal units; for ERC-20 transfer arguments use the contract's 6-decimal units. Test balance deltas and the 10^12 conversion factor, including native dust. Do not copy a conflicting example snippet without reconciling it with on-chain behavior.
- Token decimals come from validated contract/mint data, not a ticker symbol or a globally assumed 18. Preserve unknown metadata as unknown. Default UI support allows 0–36 decimals; refuse unsafe/excessive values explicitly rather than overflow or guess.

## 3. EVM adapter

### Balances, token import and discovery

Use ethers 6 and `bigint`. Native balance uses `eth_getBalance`; ERC-20 uses `balanceOf`, with bounded metadata calls. A custom import verifies checksum/syntax, bytecode presence, standard methods and decimals on the selected chain. Do not label an imported contract trustworthy just because it implements ERC-20. Support tokens without a readable name/symbol using address-based labels. Deduplicate by network plus contract, not ticker.

Discover assets from the seeded registry, user imports and tracked Transfer events. Generic EVM RPC has no universal “all tokens owned by this address” method; do not promise complete historical asset discovery without an index. Automatic history starts at a known deployment/watch start block with an explicit backfill option and progress indication.

For ERC-721, use ERC-165 plus `ownerOf` and tracked Transfer events. For ERC-1155, use standard interfaces, `balanceOf`/`balanceOfBatch`, TransferSingle and TransferBatch. Do not depend on ERC721Enumerable. Collect token IDs from indexed events/registry and manually imported IDs. Check ownership and quantity again before transfer.

### Transaction preparation and fees

Prepare native transfer, ERC-20 transfer/approve, ERC-721 safe transfer, ERC-1155 safe transfer and the project contract calls. Check recipient, integer amount, balance, selected account, contract identity and network. Detect zero/self-address transfers and require a deliberate warning acknowledgement where meaningful. A checksummed address proves syntax, not the destination blockchain or owner.

Get nonce from pending state and reserve it per account/network across wallet windows. Use `eth_estimateGas` with the actual calldata/value, then a bounded safety margin of 20%. Prefer EIP-1559 when the chain supports it; otherwise use a validated legacy gas price. Display estimated fee and a maximum bound separately. Never force a hardcoded gas price across all seven networks.

Include all chain-specific fees in affordability checks. Base may include L1 data/operator components beyond L2 execution; use its current documented fee-estimation interfaces and compare with actual receipts. Robinhood uses a Nitro-based fee model; verify whether its gas estimate already includes the L1 component and avoid double counting. If the complete fee cannot be estimated, explain the limitation and block “send max” instead of treating the missing part as zero.

For HyperEVM use small-block-compatible transaction sizes for this project's simple operations, bounded log queries and polling. The official RPC documents historical-state limitations and a 50-block log-query range; do not require historical `eth_call`, WebSocket support, or paid archival data. Build each profile's capabilities from verified RPC behavior.

Before signing, run a read-only call/simulation where available and decode supported failures. Simulation is advisory, not a guarantee against later state changes. Fees, allowance spender, token amount, chain and exact contract method appear in the approval page. Default approvals are exact amounts, not unlimited allowances. Handle nonzero-to-nonzero allowance changes with an explicit reset-to-zero transaction when needed.

### Broadcast and confirmation

Verify chain ID in the signed transaction and recover its signer in tests. Journal the expected hash before broadcasting. Use receipt status to distinguish successful execution from a revert; failed transactions can still pay fees. Track nonce replacements, removed logs and block-hash changes. Never show success solely from receiving a transaction hash.

Default UI inclusion thresholds: local EVM 1 block, Sepolia 2 blocks, Base/Robinhood/Arc 2 observed blocks, Polygon/BSC 3, HyperEVM 2. These are **application confirmation thresholds, not claims of irreversible finality**. Store and show chain-reported `safe`/`finalized` status when supported; keep L2 inclusion and L1 settlement distinct. Network-specific protocol finality handling can refine the label after a documented check.

## 4. Solana adapter

Use Kit and compatible generated System, Token, Token-2022, Associated Token and Compute Budget instruction clients. Use the compatible Metaplex Token Metadata client for standard NFT metadata. Resolve installed package names/exports from their primary documentation and pin a tested compatible set; do not mix legacy transaction objects into Kit messages.

Derive the user's Ed25519 key only inside the Worker. Fetch SOL balance and token accounts by owner, respecting token program ID. Validate mint authority/freeze state/decimals and token-account ownership. For sends, derive the correct associated token account (ATA) using owner, mint and program ID. Create a missing recipient ATA idempotently; display its rent and creation cost. Never send tokens to a system account as if it were an ATA.

Construct SOL transfers with the System Program and tokens with checked transfer instructions. Build complete transaction messages, fetch a recent blockhash and `lastValidBlockHeight`, estimate the transaction fee and account rent, simulate, and then approve/sign the exact message. Poll signature status with blockhash expiry handling; distinguish processed, confirmed and finalized. A stale blockhash requires a new review and signature, not silent reuse.

Support legacy and v0 messages if fully decoded. For v0, resolve address lookup tables before review, validate all accounts/program IDs and reject unresolved tables. Reject durable nonces and unsupported instruction families in the baseline. Validate that the selected account is an expected signer and fee payer; do not add unseen instructions after approval. Message signing uses Ed25519 with explicit bytes/text/domain preview, separate from transaction signing.

Standard NFTs: decimals 0, supply 1, supported noncompressed token standard, standard token account ownership and Metaplex metadata when present. Transfer one token to the correct recipient ATA. A token that merely has zero decimals is not automatically a verified collectible. Local fixtures have a registered NFT mint and real metadata account; public NFTs require supported standard/metadata validation. Show unsupported programmable/compressed NFTs without offering a broken send button if discovered.

Parse Token-2022 extension sets before claiming support. Mandatory baseline supports extension-free fungible Token-2022 mints; reject transfer hooks, transfer fees, confidential transfers, nontransferability and unsupported account extensions with a clear reason. Test frozen accounts and revoked/changed authorities. Delegate revoke is a real Token Program revoke instruction; disconnecting a dapp alone does not revoke it.

Local validator runs with the standard token programs and a pinned Metaplex metadata program, prepared in phase 4. No custom Rust program is required for the wallet's baseline. Our Solidity contracts remain EVM-only.

## 5. Bitcoin adapter

Use Bitcoin Core regtest for full acceptance. Store the chain fingerprint and `bcrt` address prefix in profile validation; never show regtest as mainnet or public testnet. Support P2WPKH and key-path P2TR accounts, including receive and change addresses. No legacy/P2SH, inscription or token support is required.

The backend imports **public ranged descriptors** into a watch-only Core wallet (`disable_private_keys=true`) or maintains an equivalent public-script index. It never imports the browser wallet's private descriptor, xprv or seed. Keep a separate funding/mining wallet only in the test seeder, not the public API. Extended public keys expose future address activity; send them only to the explicitly configured backend after a privacy explanation, not to arbitrary services.

Implement external and change discovery with gap limit 20, reserved next address indexes and persisted derivation metadata. Maintain UTXOs by outpoint, amount, script, derivation path, confirmation depth and spent/reserved state. Do not treat an account's displayed total as its spendable balance.

Coin selection is deterministic: prefer sufficient confirmed outputs while minimizing change/fee, with a documented largest-first fallback. Bound input count to prevent oversized transactions. Estimate virtual size from actual input/output types and use sat/vByte, never sat/byte. Query Core's fee estimate; regtest frequently lacks fee history, so use a visibly labelled **local-only fallback of 2 sat/vByte**. Never apply that fallback to a public/mainnet network.

Compute recipient output, independently derived internal change and fee. Respect script-specific dust policy. If change would be dust, show the increased fee and require the updated review. Reject negative/zero outputs, fee greater than inputs, excessive fee rates and hidden outputs. “Max” requires a final selection/fee calculation, not total balance minus a fixed number.

Build PSBTs with validated witness UTXO data. Re-fetch/verify referenced outputs against the node before approval. Validate each input's ownership and value; validate every output's address/script and amount. Change is recognized by derivation from our own public account, never from a dapp-supplied `isChange` flag. Reject unknown inputs in the initial reference flow, unsupported scripts, missing UTXOs and arbitrary sighash variants. Allow P2WPKH SIGHASH_ALL and Taproot key-path SIGHASH_DEFAULT only.

Use bitcoinjs-lib with tiny-secp256k1 initialized once, and tested upstream Taproot key-tweak helpers/patterns. Verify signatures, finalize the PSBT and independently decode the final transaction before broadcast. Inputs/outputs must match the reviewed PSBT. Use Bitcoin Core `testmempoolaccept` in tests and optionally preflight before broadcast.

Reserve UTXOs across tabs until rejection or reconciliation. Track mempool, confirmations, conflicts and reorgs. One confirmation may be displayed as confirmed for the local demonstration; six as the chosen completion threshold, both clearly stated. Mining is a CLI/test action only. Fee bumping and CPFP are not mandatory UI features; detect external replacements/conflicts and do not auto-spend a reserved input twice.

## 6. Contract suite and exact responsibilities

Use nonupgradeable contracts, OpenZeppelin primitives, explicit access controls, custom errors and events. Keep business logic small enough to explain in the project evaluation. Generate ABIs/types from compiled artifacts; do not maintain handwritten ABIs that drift from source. Never deploy these educational contracts to mainnet.

| Contract | Required interface/behavior | Important constraints |
|---|---|---|
| `DemoERC20` | Configurable name/symbol/decimals, capped mint by MINTER_ROLE | Normal fixtures use fixed decimals 6 or 18; no unrestricted public mint |
| `DemoNFT721` | Controlled mint, token URI, safe transfers | IDs/ownership from events; metadata points to safe fixture assets |
| `DemoNFT1155` | Controlled mint/batch mint, URI, safe transfers | Quantity-aware ownership; receiver acceptance checks |
| `DemoFaucet` | `claim(token)`, per-address/token cooldown, fixed claim amount | Allowlisted demo tokens, 60-second local cooldown, role-limited mint, capped claims |
| `SavingsVault` | `deposit(token, amount, duration)`, `withdraw(positionId)`, view positions | Fixed beneficiary=depositor, immutable unlock time, no interest/returns promise |
| `SharedWallet` | Three distinct owners; propose/approve/revoke/execute | Threshold exactly 2; no owner replacement/upgrade mechanism in baseline |
| `DemoSwapPool` | Fixed pair reserves, `quoteExactInput`, `swapExactInput` | Real constant-product swap with slippage and deadline enforcement |
| `DemoBridgeLock` | Lock source test tokens and emit message ID | Local EVM A only; amount/recipient/destination encoded |
| `DemoBridgeMint` | Role-restricted mint with consumed message ID | Local EVM B only; educational centrally coordinated simulation |

### Faucet and minting

Separate deployer, seeder and user roles. Revoke unnecessary deployer mint authority after seed initialization, retaining only the intended faucet/simulation roles. Faucet mint has per-token claim amount and cooldown; unauthorized token requests revert. All token names include Demo or Test. Mock USD tokens are never claimed to be redeemable stablecoins.

### Savings vault

Support allowlisted ordinary ERC-20 assets. Each position records owner, token, exact deposited amount, deposit time, unlock time and withdrawn flag. Choose allowed durations: 60 seconds, 5 minutes and 1 hour for local demonstration; configurable testnet minimum must be shown. No automatic yield is generated. Use `SafeERC20`, nonreentrancy, checks-effects-interactions and actual received-balance validation. Reject fee-on-transfer/rebasing behavior in the initial allowlist.

Only the owner can withdraw, only after `block.timestamp >= unlockAt`, and only once. Set state before the external transfer. No admin can withdraw a user's locked principal. Contract timestamps, not the user's device clock, determine eligibility. Events: `Deposited(positionId, owner, token, amount, unlockAt)` and `Withdrawn(positionId, owner, amount)`.

### Two-of-three shared wallet

Constructor rejects zero/duplicate owners. Proposal stores destination, native value, calldata, proposer, executed flag and confirmation count. ID is an incrementing contract-local proposal ID. Owners can approve once and revoke before execution. An owner may execute only with two current distinct approvals. Mark executed before the external call, use nonreentrancy, and revert the whole operation if the target call fails. No signature aggregation is necessary; approvals are actual on-chain transactions from different owners.

Support receiving native coins and ERC-20, plus receiver interfaces if NFT deposits are enabled. UI decodes supported transfer calls, displays full recipient/token/value and rejects unsupported arbitrary proposal calldata in the initial web UI. Contract tests still exercise hostile target contracts. Events: `Proposed`, `Approved`, `Revoked`, `Executed`. Do not confuse “two derived accounts from one seed” with independent custody; use three distinct fixture roots/browser profiles for acceptance.

### Test-token AMM

Use a fixed dUSDC/dDAI pair, seeded once by the deployer, with 0.30% fee and no public liquidity-management UI. Quote in raw base units:

```text
amountInWithFee = amountIn * 997
amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee)
```

All arithmetic is integer arithmetic. With 6-decimal dUSDC and 18-decimal dDAI, reserves are already expressed in their respective base units; do not normalize incorrectly inside the invariant. Round output down. Enforce positive input, initialized reserves, `amountOut >= minAmountOut`, deadline, supported pair and balance-delta checks. Use nonreentrancy and SafeERC20; reject fee-on-transfer/rebasing assets. Reserves must reflect actual balances and swaps must preserve the intended fee-adjusted invariant.

UI defaults: 0.5% slippage, maximum selectable 5%, 30-second quote freshness and five-minute on-chain deadline. Two steps—exact approval then swap—each require review. If an allowance already covers input, skip the approval transaction. A quote from before an approval may become stale; refresh it before reviewing the swap. Show fee, price impact, minimum received and the explicitly synthetic demo valuation.

### Bridge simulation

Use actual local lock and mint transactions on chain IDs 31337 and 31338, orchestrated by a CLI demo relayer. The relayer is a trusted educational component, not a decentralized bridge. It has no user-wallet private key. Derive a message ID from source chain, source contract, source event/nonce, destination chain, recipient and amount; reject duplicate mint processing and bind destination.

Mandatory UI label: **“Bridge simulation — local test tokens only.”** Implement source pending/locked, waiting, destination minted, relayer timeout and retry. No automatic refund is required; say “locked in simulation; resume relayer or reset local demo” after timeout. Do not advertise a refund guarantee. Reorg/replay fixtures must stop an unsafe duplicate mint. Public cross-chain transfers and production bridge security are excluded.

## 7. Deployment and contract verification

Deployment scripts verify network identity, use a fixture-only deployer for local networks, and use a separately generated testnet-only signer file for public networks. Never use a private key embedded in frontend code or ask the user to paste a real wallet seed into an environment file. Public deployment requires funded free test coins; if unavailable, write a blocked result and continue local work.

Generate `artifacts/deployments/<network-id>.json` with chain/genesis identity, seed schema/run ID, block height, contract addresses, constructor arguments, ABI artifact hashes, deployed bytecode hashes, compiler/settings, deployment transaction hashes and timestamp. Verify code at each address before enabling contract UI. A changed local genesis or missing code invalidates the manifest.

Use the full service suite on local EVM A, lock/mint components on A/B, and at least one full public service deployment on Sepolia when free gas is available. For all seven EVM testnets, deploy lightweight ERC-20/ERC-721/ERC-1155 fixtures and exercise required wallet standard operations separately. Do not assume the Sepolia deployment exists on Base or Arc at the same address.

## 8. Adapter/contract implementation tasks

| Task | Deliverable | Minimum proof |
|---|---|---|
| B01 | Local nodes and verified network registry | Identity mismatches block writes; health report per profile |
| B02 | EVM native/ERC-20 balances and send | Real receipt, fee, before/after balances, wrong-chain rejection |
| B03 | EVM NFTs and allowance operations | 721 ownership, 1155 quantity and approval/revoke changes |
| B04 | Contract suite and generated types | Access/rounding/replay/reentrancy tests and deployment manifests |
| B05 | Contract service UI wired to Worker | Faucet, vault maturity, two-owner execution, real AMM swap |
| B06 | Solana SOL/SPL/NFT/fee/delegate operations | Real local signatures, ATA creation, expiry and unsupported-type checks |
| B07 | Bitcoin P2WPKH/P2TR and PSBT | Regtest sends from both script types; change and fee verified by Core |
| B08 | Public network configurations and fee/finality policies | Each endpoint probed independently; results are honest passed/blocked/failed |
| B09 | Portfolio/send/history stub replacement | All three chain architectures use node data and the same approval lifecycle |

Commands: `pnpm infra:up`, `pnpm networks:check`, `pnpm contracts:compile`, `pnpm contracts:test`, `pnpm deploy:local`, `pnpm test:adapters`. Implement bounded health polling rather than arbitrary long sleeps. Minimal local fixtures here must be compatible with phase 4's manifest, not a second incompatible seeding system.

**Gate G3:** local EVM, Solana and Bitcoin transfers work through the real browser UI and Worker; standard NFTs transfer; fee/balance arithmetic is exact; contract suite passes negative tests; local swap actually changes on-chain balances; shared wallet needs two independent owners; unknown network/payload requests fail closed. Public-testnet verification may be pending funding and must be reported separately. Save evidence under `artifacts/phase-03/`.

Next: [04_SEEDING_INDEXING_AND_DAPPS.md](04_SEEDING_INDEXING_AND_DAPPS.md).

## 9. Primary references

- [ethers v6](https://docs.ethers.org/v6/), [OpenZeppelin Contracts 5](https://docs.openzeppelin.com/contracts/5.x), [Hardhat 3](https://hardhat.org/docs/getting-started).
- [Base network details](https://docs.base.org/get-started/connect-to-base), [Polygon Amoy setup](https://docs.polygon.technology/tools/dApp-development/common-tools/remix/), [BNB RPC endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/).
- [HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) and [RPC limitations](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc).
- [Robinhood network configuration](https://docs.robinhood.com/chain/add-network-to-wallet/).
- [Arc connection details](https://docs.arc.io/arc/references/connect-to-arc) and [gas/precision rules](https://docs.arc.io/arc/references/gas-and-fees).
- [Solana SDK](https://solana.com/docs/clients/official/javascript), [Solana clusters](https://solana.com/docs/references/clusters), [Metaplex Token Metadata](https://github.com/metaplex-foundation/mpl-token-metadata).
- [bitcoinjs-lib](https://github.com/bitcoinjs/bitcoinjs-lib), [Bitcoin testing](https://developer.bitcoin.org/examples/testing.html), [PublicNode](https://ethereum.publicnode.com/).

Configuration values are starting inputs, not proof that an endpoint was contacted by this planning task. Implementation evidence must contain actual observations.
