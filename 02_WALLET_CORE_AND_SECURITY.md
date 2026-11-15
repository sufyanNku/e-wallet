# 02 — Browser wallet core, recovery and signing security

**Prerequisite:** Gate G1 in [01_FRONTEND_AND_FOUNDATION.md](01_FRONTEND_AND_FOUNDATION.md).  
**Outcome:** a real browser wallet can create/import, encrypt, restore, lock and approve signing operations. Blockchain-specific preparation and broadcast are connected in phase 3. This is a website; do not introduce an extension or native app.

## 1. Trust model and implementation boundaries

The browser wallet owns secrets. The backend, blockchain RPCs, metadata hosts and connected dapps are untrusted with respect to secrets and transaction intent. The wallet's own JavaScript supply chain and hosting origin are security-critical: a same-origin script compromise can mislead the UI or invoke Worker messages. A Web Worker is an isolation/organization boundary, not protection against all same-origin XSS. The assessed product is a test-network university prototype, not an audited production custody system.

Use a dedicated module Web Worker per wallet window. Import wallet-core only there. Keep decrypted recovery data, derived private keys and an AES key only in Worker memory. The React host receives public account details, safe errors, previews and signatures/receipts when needed. Recovery reveal is an explicit, short-lived exception requiring password re-entry; never place recovery data in a global UI store or developer tools state.

Each tab/window starts locked. Opening a dapp approval window may require unlocking it even if another wallet tab is unlocked. Do not share decrypted keys via BroadcastChannel, SharedWorker, localStorage, cookies, IndexedDB plaintext, URLs or backend sessions. A BroadcastChannel carries only nonsensitive lock/data-revision notifications. Closing/reloading a window destroys its Worker session and requires unlocking again.

The signing interface accepts approved typed operations, not arbitrary private-key export or unconstrained `sign(bytes)` messages. Separate lifecycle, preparation, approval and signing message types. No server endpoint accepts a user's seed, password or private key.

## 2. Vault and browser persistence

Use IndexedDB through the small `idb` wrapper, with separate stores for vault envelope, public account metadata, preferences, contacts, permissions, transaction journal and schema migrations. Store raw token quantities as decimal strings. Set browser persistence with `navigator.storage.persist()` when available, but do not promise that browser data cannot be deleted. Explain recovery on a new browser/device through the recovery phrase.

Browser storage belongs to an exact origin. Development at port 5173 and evaluation at port 8787 do not share a vault; `localhost` and `127.0.0.1` are also different hosts. Use the documented canonical URLs consistently. Restore explicitly in a fresh evaluation profile; never transfer secrets by query string or assume changing the deployment hostname preserves local storage.

### Encrypted envelope version 1

```ts
type VaultEnvelopeV1 = {
  version: 1;
  walletId: string;
  revision: number;
  kdf: {
    name: 'PBKDF2'; hash: 'SHA-256'; iterations: 600000;
    saltBase64: string;
  };
  cipher: {
    name: 'AES-GCM'; ivBase64: string; tagLength: 128;
    ciphertextBase64: string;
  };
  createdAt: string;
};
```

- Use Web Crypto and fresh CSPRNG-generated 16-byte salt and 12-byte AES-GCM IV. AES key length is 256 bits. Never reuse an IV with the same key.
- Derive the key from the exact UTF-8 password using PBKDF2-HMAC-SHA256, minimum 600,000 iterations. This is the browser-compatible project choice; it is not a claim that the application is FIPS certified. Benchmark on the evaluation device without lowering the minimum.
- Bind version, wallet ID, KDF parameters and revision as canonical authenticated additional data. Define one canonical serializer; parse and validate parameters before decryption. Bound KDF parameters and payload size to prevent an imported file causing unbounded work.
- Encrypt the mnemonic entropy and optional BIP39 passphrase, derivation schema version and necessary secret material. Public indexes/names may be stored separately; secrets never may.
- Do not store a password hash for verification. Successful authenticated decryption verifies the password. Use one safe error for wrong password or corrupted data, with separate nonsensitive diagnostics when useful.
- Password policy: at least 12 characters, allow spaces/Unicode, maximum 1,024 UTF-8 bytes; do not silently trim or normalize passwords. Confirm on creation/change. Use progressive delays after failed unlock attempts; do not erase the vault after failures.
- Persist envelope changes atomically in an IndexedDB transaction with a revision check. Verify new encryption/decryption before replacing the old envelope. A quota/storage failure must not display successful backup or password change.
- Migrate envelopes only after successful unlock; preserve an encrypted rollback copy until the migration validates. Never migrate by persisting plaintext.

Store one root wallet per browser profile for the initial release, with multiple derived accounts. Recovery of another root is a deliberate replace-wallet flow requiring backup acknowledgement; the three multisig owners use three distinct browser profiles. Do not silently merge two phrases into one wallet.

## 3. Creation, import and recovery

New wallets default to **24 English BIP39 words** from 256 bits of `crypto.getRandomValues` entropy. Import accepts valid 12- or 24-word English BIP39 phrases. Support an optional BIP39 passphrase behind an advanced control; clearly distinguish it from the local unlock password. Normalize mnemonic/passphrase according to BIP39, verify checksum, and reject invalid words or word count. Never “correct” a phrase into a different valid wallet automatically.

Use `@scure/bip39` for BIP39, `@scure/bip32`/bip32 for secp256k1 derivation and the `micro-key-producer` SLIP-0010 implementation for hardened Ed25519 derivation. Use their upstream test vectors. Do not implement derivation, ECDSA, Schnorr, Ed25519, or entropy generation yourself.

| Family | Exact derivation convention | Restore behavior |
|---|---|---|
| EVM | `m/44'/60'/0'/0/i`, starting at `i=0` | Same address on all seven EVM profiles; balances remain network-specific |
| Solana | `m/44'/501'/i'/0'`, starting at `i=0` | Hardened Ed25519 account derivation; retain selected account index |
| Bitcoin P2WPKH | `m/84'/1'/a'/c/i` | Test/regtest coin type 1, account `a`, external `c=0`, change `c=1` |
| Bitcoin P2TR | `m/86'/1'/a'/c/i` | Key-path Taproot; same account/change/index structure, distinct addresses |

Track accounts by family and derivation path, not UI label. A logical portfolio account can group corresponding EVM, Solana and Bitcoin account indexes; show the different addresses clearly. A seed imported from another wallet is not guaranteed to expose its entire history automatically because that wallet may use other paths. In advanced recovery allow the exact supported path families and sequential account discovery; do not accept an unrestricted arbitrary derivation template.

For EVM/Solana recovery, initially derive account indexes 0–19 with bounded requests and offer explicit continuation. For Bitcoin implement external and change gap-limit scanning of 20 unused addresses per supported account, increasing on user request. Store public discovery progress. Offer reconstruction from a public account-metadata backup to avoid losing the last-used indexes; it is a convenience, not a replacement for the recovery phrase.

On creation, show the phrase only inside the wallet origin, require acknowledgement plus a randomized three-word check, then clear the displayed phrase. Do not put it on the clipboard automatically. Optional copy requires an explicit action and a warning that clipboard clearing is best-effort. Disable spellcheck/autocomplete on secret inputs. Exclude onboarding/reveal pages from screenshots, session recordings and telemetry. Tests use published test vectors and scrub their artifacts.

On restore, derive addresses and compare them against expected test vectors before announcing success. Wallet reset deletes only this application's local data after password verification and backup acknowledgement; it does not delete blockchain funds. There is no email password reset. A forgotten password requires phrase restoration, and a lost phrase cannot be recovered by the project team.

## 4. Locking and sensitive operations

Default idle timeout is five minutes, selectable as 1, 5 or 15 minutes. Lock after 60 seconds continuously hidden, on explicit lock, on page close/reload, on root-wallet replacement, and on session invalidation. Implement deadline checks inside the Worker before every sensitive operation; browser timer throttling must not bypass a deadline. A newly visible page refreshes lock state before enabling controls.

Require password re-entry for phrase reveal, encrypted backup export and password change, even if the wallet is unlocked. Export only the versioned encrypted envelope plus supported public restore metadata. Restore/export must work without backend access. A signature cannot be approved while locked.

On lock, reject pending approval/signing requests, drop derived signers and key references, terminate/recreate the Worker if needed, clear transient UI secrets and invalidate in-memory approval tokens. Best-effort zero mutable byte buffers; acknowledge that JavaScript garbage collection does not provide guaranteed memory wiping. Lock broadcast messages affect all tabs; unlock never unlocks another tab.

Use the Web Locks API plus IndexedDB transactional revision checks to coordinate writes and nonce/UTXO reservations across same-origin windows. If Web Locks is unavailable, use an IndexedDB lease with expiry and compare-and-swap semantics. Never rely on localStorage flags for transaction exclusion.

## 5. Typed Worker protocol and approval state

Version messages as `{ protocolVersion, id, method, payload }`, validate with Zod, cap payload sizes and return typed safe errors. Keep the Worker URL local and bundled. Request IDs must be unique within a session. Worker replies go only to the owning host channel; external windows never message the Worker directly.

Required lifecycle methods: `vault.create`, `vault.import`, `vault.unlock`, `vault.lock`, `vault.changePassword`, `vault.exportEncrypted`, `vault.revealRecovery`, `accounts.list`, `accounts.derive`, `accounts.select` and `session.status`. Destructive/reset methods are separate and require explicit UI acknowledgement.

Required transaction methods: `operation.prepare`, `operation.review`, `operation.approve`, `operation.reject`, `operation.execute`, `operation.status`. Preparation accepts an intent, validates it, reads current network state and returns an immutable unsigned operation plus preview. Approval binds all relevant fields:

- Network/genesis identity, selected account, origin/request ID and operation kind.
- Recipient, asset identifier and exact amount; contract address/function/arguments or instruction set.
- EVM nonce and fee ceiling, Solana blockhash/lifetime/signers, or Bitcoin input outpoints/output scripts/change/fee.
- Payload digest, quote/minimum-output constraints, creation time and expiry.

Default review expiry: 60 seconds, or a shorter chain-specific lifetime. If a fee, payload, recipient, account, chain or quote changes, require a new review. Recheck balance/allowance/UTXO availability immediately before signing. Signing must serialize the reviewed payload, not reconstruct a different transaction from mutable form state.

An approval token is one-use, bound to the current unlocked Worker session and operation digest. It is never exposed to a dapp or persisted. Double clicks, retried messages, browser back/forward navigation and multiple windows must not produce a second signature for the same request. Cancellation before signing does not broadcast. Cancellation after submission changes only local UI, not the blockchain transaction.

Do not implement blind arbitrary contract signing in this university build. Support decoded native/token/NFT transfers and the explicitly integrated contract methods, EIP-712 typed messages with complete domain review, and bounded human-readable messages. Reject unknown instructions/selectors in dapp-origin requests with an informative unsupported-operation error. This capability boundary must be visible to the reference dapp.

## 6. Transaction journal and recovery after uncertainty

Persist the public operation journal in IndexedDB before network submission. Compute the transaction hash/signature/txid from signed bytes when the protocol supports it, save the expected identifier and a bounded copy of signed bytes needed for reconciliation, then broadcast. Signed bytes can authorize an operation even though they are not a private key: do not put them in logs, URLs, screenshots or backend analytics. Retain only as long as recovery needs them.

Use these states with explicit transitions:

| State | Meaning and next action |
|---|---|
| `draft` | Editable form; no chain operation prepared |
| `review_ready` | Immutable preview with expiry |
| `awaiting_approval` | Waiting for explicit user choice |
| `rejected` / `expired` | No signing; terminal unless a new intent is created |
| `signing` | One-use approval consumed; serialized local operation |
| `signed` | Expected identifier journaled; may be broadcast |
| `submitted` | Node accepted the signed operation |
| `submission_unknown` | Timeout/disconnection; query expected ID before any retry |
| `included` | Seen in a block/slot; confirmation/finality policy pending |
| `confirmed` / `finalized` | Chain-specific threshold/status reached; do not equate all chains' guarantees |
| `reverted` | Included but execution failed; may still have paid fees |
| `dropped` / `replaced` | Proven drop or identified replacement; show relationship |
| `orphaned` | Prior inclusion removed by reorg; resume reconciliation |

On timeout never create a new nonce, new Bitcoin inputs or refreshed Solana transaction automatically. Query the expected identifier and relevant account state. Rebroadcasting the identical signed bytes may be safe within their validity period; creating a new payload requires a new review. Expired Solana transactions require fresh blockhash and approval. Release reservations only after safe reconciliation or explicit expiry rules.

Use exponential backoff with jitter for read requests, 10-second RPC timeouts and bounded retries. Broadcast is handled separately from retryable reads. Emit one notification per meaningful state transition with a durable deduplication key. Errors must distinguish user rejection, insufficient funds, wrong network, unsupported asset, fee changes, stale quote, RPC failure and actual execution failure.

## 7. Website security and data separation

Serve production/evaluation builds from localhost or HTTPS. Block secret creation/import/signing in insecure non-loopback HTTP contexts. Use a strict CSP: scripts and workers from self, no inline scripts or eval, no remote JavaScript, no third-party analytics, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, and a narrow `connect-src` covering the backend and approved RPCs. If tiny-secp256k1 requires packaged WebAssembly, permit only the minimum `wasm-unsafe-eval` capability and test the built bundle; do not enable ordinary `unsafe-eval`.

Use `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and appropriate Permissions-Policy. Keep service workers/PWA/offline HTML caching out of scope so an outdated signing application cannot silently persist. Cache hashed static assets immutably; revalidate HTML/config on load. Abort pending signing on a detected incompatible application version change.

Render token names/descriptions as text. Never render fetched HTML or SVG scripts. Package trusted local icons; remote media is handled by the safe metadata pipeline in phase 4. QR payloads, contract revert strings and dapp messages are untrusted. Limit string lengths, parse URLs with a URL parser and allow only permitted schemes. External links open with `noopener,noreferrer`; the dedicated dapp connection protocol is the only intentional opener relationship.

Store no secrets in React state persistence, query caches, console output, HTTP headers, error stacks, CI environment dumps or screenshots. Add a logger redaction policy for seed/mnemonic/password/privateKey/signedPayload fields and a test that spies on console/network calls during create/import/sign/reveal. Do not assume redaction alone makes logging secrets acceptable.

Use separate IndexedDB namespaces for fixture/local/public-testnet environments. Mainnet configurations are not included as signable profiles. Reject unknown chain identities in the Worker, not merely by hiding UI options. Public-testnet seeds must be newly generated local secrets, never the published local demo seed. Public seed scripts never read the user's actual browser vault.

## 8. Backend session boundary

The backend has **no user authentication or recovery secret database**. It may establish a short-lived anonymous browser session solely to scope watch-only data and rate limits. Implement `POST /api/v1/session` with an exact allowed Origin, JSON content type and Fetch Metadata validation; return a CSRF token and set a random opaque HttpOnly, SameSite=Strict cookie. Store only a hash of the session token, expiry and public watch configuration. Set Secure on HTTPS; loopback development is the explicit exception.

Require that cookie, CSRF header and exact allowed origin on state-changing API routes. Development CORS permits only `http://127.0.0.1:5173` with credentials; release serves wallet and API from one origin. Do not allow `*`, reflect arbitrary origins, or use CORS as the only authorization check. Validate Host to defend local DNS rebinding. Bind evaluation services to `127.0.0.1`, not every interface.

Session loss affects backend history subscriptions, not wallet ownership. Users can recreate a watch session from their public accounts after unlocking. Backend failures cannot unlock or recover the wallet. Seed/admin actions exist only as CLI commands and are never public HTTP routes. Public deployment, if later used, needs HTTPS and per-session quotas; it must not expose local node admin RPCs.

## 9. Implementation tasks and tests

| Task | Deliverable | Required checks |
|---|---|---|
| C01 | Worker message schemas, bounded RPC host, typed gateway | Unknown method, malformed payload, duplicate ID and oversized request rejected |
| C02 | Encrypted IndexedDB vault and migration transaction | Wrong password, corrupted tag, changed AAD, randomized ciphertext, quota failure |
| C03 | BIP39 and family derivation | Independent known vectors; creation randomness; identical recovery addresses |
| C04 | Real create/import/backup/restore UI | Browser reload, phrase check, passphrase differences, no secret persistence outside envelope |
| C05 | Account management and discovery | Path isolation; EVM shared address versus per-chain balances; Bitcoin gap handling |
| C06 | Lock/password/export/reset lifecycle | Idle/hidden/tab-close lock, cross-tab lock, stale Worker messages, atomic password change |
| C07 | Approval state machine and public journal | Payload mutation, expired approval, rejection, double click, reload after signed-before-broadcast |
| C08 | CSP, origin/session boundaries and redaction | Built-site headers, blocked inline code, malformed origin, no secret on network/logs |
| C09 | Replace mock lifecycle screens with real browser core | Mock and real stores cannot cross-contaminate |

Add `pnpm dev:wallet`, `pnpm test:core` and `pnpm test:security` scripts. `dev:wallet` runs the real wallet frontend on port 5173 and backend on 8787; RPC-dependent features may show a clear unavailable state until phase 3. It must never silently fall back to fixture balances.

**Gate G2:** wallet creation/import and encrypted restore work in a normal browser; known EVM/Solana/Bitcoin derivation vectors match; reload/lock prevent signing; password change survives restart; no secrets appear in backend requests/storage/logs; approval digest/race checks pass; the real frontend uses the Worker boundary. Save evidence under `artifacts/phase-02/`. Chain end-to-end transfers are a phase 3 gate, not a false phase 2 pass.

Next: [03_CHAINS_CONTRACTS_AND_TRANSACTIONS.md](03_CHAINS_CONTRACTS_AND_TRANSACTIONS.md).

## 10. Primary references

- [BIP39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki), [BIP84](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki), [BIP86](https://github.com/bitcoin/bips/blob/master/bip-0086.mediawiki): derivation and recovery standards.
- [micro-key-producer](https://github.com/paulmillr/micro-key-producer): SLIP-0010 implementation and upstream vectors.
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API): browser primitives and secure contexts.
- [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): PBKDF2 work-factor reference; our encrypted vault format and browser protocol are project design decisions.
- [bitcoinjs-lib](https://github.com/bitcoinjs/bitcoinjs-lib): supported signing/PSBT APIs and browser cryptography cautions.
