# e-wallet: user and developer guide

Read this file first if you are new to the project.

## 1. What this application does

e-wallet lets a person create a wallet, manage accounts, view assets, send and receive payments, and use supported network services. It has a web application and an Android/iOS application.

There are **28 feature groups**, explained in section 4. Some groups contain related actions, such as adding, editing and deleting a contact. This count describes this project's features; it does not mean it contains every feature of another wallet.

- **Web:** All 28 groups.
- **Native mobile:** 16 of these groups; each heading below states where the feature is available.

The project has two separate areas:

- **Crypto wallet:** Uses a recovery phrase and a wallet password. It interacts with Ethereum-compatible, Solana and Bitcoin development networks. Signing happens on the user's device.
- **Accounts:** Uses a username and password. Alice and Bob can transfer credits. Admin and Auditor accounts demonstrate role-based permissions. These credits are stored in SQLite and are separate from crypto balances.

The current project is configured for local chains and public testnets. Real-fund launch is deferred. The interfaces use ordinary wallet wording, but changing the wording does not enable real money. Use only the project's testing identities and assets.

### Useful words to know

- **Recovery phrase:** The words needed to restore a crypto wallet. Keep them private.
- **Wallet password:** Unlocks the encrypted wallet on one browser origin or device. It is not the Accounts login password.
- **Address:** The public destination used to receive an asset.
- **Network:** The blockchain on which an address, balance or transaction is used. Always match the sender's and recipient's networks.
- **Network fee:** The charge for a blockchain transaction. Sending a token may also require a small balance of that network's native asset.
- **Token:** An asset carried by a network. This project's prepared tokens include dUSDC and dDAI; these names do not mean you own actual dollars.
- **Allowance:** Permission for a contract to spend up to a specified token amount. Approving an allowance is separate from making a swap or deposit.
- **Collectible / NFT:** An item whose ownership is identified by a contract or mint and an item identifier.

## 2. Start the application

### Option A: Accounts and credit transfers

Use this option for username login, credit transfers and roles. Blockchain nodes are not required.

1. Install pnpm **10.34.9** and open a terminal in the project folder.
2. Run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm node --version
   pnpm build:wallet
   pnpm accounts:setup
   pnpm dev:accounts
   ```

3. `pnpm node --version` should show **v24.22.3**. The workspace selects this runtime even if your terminal normally uses Node 22.
4. Open **http://127.0.0.1:5173/accounts**.
5. Read the generated usernames and passwords from `.local/local/accounts-credentials.json`.
6. Sign in as Alice in a normal browser window and Bob in an incognito window.
7. Follow features 26–28 below. For detailed login and role checks, see [ACCOUNTS_GUIDE.md](ACCOUNTS_GUIDE.md).

Stop an existing development server with **Ctrl+C** before starting another one. Re-running setup preserves existing account balances, passwords and history.

### Option B: complete crypto-wallet environment

Install Docker Engine with Compose, then run:

```sh
pnpm install --frozen-lockfile
pnpm preflight
pnpm infra:up
pnpm seed:local
pnpm accounts:setup
EWALLET_ACCOUNTS=1 pnpm dev
```

This starts the web wallet, Accounts API, reference connection application and local bridge relayer. Docker hosts the local chain nodes. Allow the seed command to finish before opening the wallet.

On Windows PowerShell, replace the last command with `$env:EWALLET_ACCOUNTS="1"; pnpm dev`.

Open these addresses:

- **Wallet:** http://127.0.0.1:5173
- **Accounts:** http://127.0.0.1:5173/accounts
- **Reference connection application:** http://127.0.0.1:5174
- **Built wallet and connection approvals:** http://127.0.0.1:8787

Use these exact addresses. `localhost`, `127.0.0.1`, port 5173 and port 8787 have different browser storage or security rules.

### Get a populated crypto wallet

A newly created wallet is empty. To explore the prepared holdings:

1. Open `.local/secrets/alice.json` locally after seeding.
2. Copy its recovery phrase.
3. On the wallet welcome page, choose **Restore wallet**.
4. Paste the phrase, create a wallet password of at least 12 characters, confirm it and restore.
5. Choose **Local Ethereum** and open **Wallet**.

Use a separate browser profile with `.local/secrets/bob.json` for Bob's crypto wallet. Alice/Bob crypto phrases are separate from Alice/Bob Accounts passwords. These published local identities must never hold real funds. Do not commit the generated secret or credential files.

### Open the mobile application

The mobile app is a native wallet, not a website inside an app.

1. Start the backend with Option B.
2. Follow [MOBILE_INSTALLATION_GUIDE.md](MOBILE_INSTALLATION_GUIDE.md) to install on Android or iPhone without a store.
3. For an Android development build, reverse ports 8787 and 8081 with ADB, then run `pnpm mobile` for Metro.
4. Open the installed app and create or restore a wallet.
5. Select the same network as the web wallet before comparing balances.

iPhone native builds require macOS/Xcode. A physical iPhone also needs a reachable HTTPS backend. The Android debug APK needs Metro; it is not a standalone release APK.

## 3. Understand the screens

**Web:** Wallet is the home screen. Use Send, Receive and Swap for payments; Activity for receipts; Collectibles for NFTs; Connected apps for permissions; Discover for market references; Address book for contacts; Network tools for contracts; Settings for security; Network status for connection information; Accounts for username logins.

**Mobile:** Use the wallet action buttons, bottom navigation, network selector and account selector. Mobile includes its own camera scanner. The web Accounts login and credit ledger are not available in the native app.

**Two users on one computer:** Use separate browser profiles, or one normal window and one private window. Two normal tabs share cookies and storage; they are not independent users. Multiple private windows may share one private session too.

## 4. The 28 feature groups: use and test

For each feature, follow **Use**, then check **Developer test**. Automated suite names are explained in section 5. Use small amounts and record balances before starting.

### 01. Create a crypto wallet — web and mobile

**Use:** Choose Create wallet, set and confirm a password, save the recovery words offline, and complete the backup-word check.

**Developer test:** Try a short password, mismatched passwords and a wrong backup answer. Each must be rejected. Correct answers should open the wallet. A fresh wallet may correctly show no assets. Automated: Core browser and unit/security suites; repeat the native screen flow on a device.

### 02. Restore a crypto wallet — web and mobile

**Use:** Choose Restore wallet or I already have a wallet. Enter the exact recovery words and optional BIP39 passphrase, then set a wallet password.

**Developer test:** Restore the same testing phrase in two independent profiles. Their addresses must match for the same network/account path. Invalid words must fail. A different BIP39 passphrase creates different accounts. Automated: Core browser and native-core suites.

### 03. Lock, unlock and automatic locking — web and mobile

**Use:** Lock the wallet using the lock control, then enter the wallet password to unlock. Web Settings lets you change the inactivity timeout. Mobile locks when backgrounded and after inactivity.

**Developer test:** Reject a wrong password. Locking must prevent preparation/signing. Reload a web window and confirm it starts locked. Locking one web window should lock other windows of the same wallet origin. Test native backgrounding and inactivity on the device. Automated: Core browser, native-core and security suites.

### 04. Change the wallet password — web and mobile

**Use:** In Settings, enter the current password, the new password and its confirmation. Select Change password or Update password.

**Developer test:** After locking, the old password must fail and the new one must work. Addresses and holdings must remain unchanged. A wrong current password or mismatched confirmation must fail. Automated: Core browser and native-core suites.

### 05. View recovery words — web and mobile

**Use:** In Settings, enter the wallet password and choose Reveal recovery phrase or Show recovery phrase. Store the words offline, then hide them.

**Developer test:** Wrong passwords must fail. Check the 30-second reveal timeout, manual dismissal and locking. On a device, also check screen capture and app-switcher privacy. Do not record recovery screens in screenshots, videos or logs. Automated core tests cover password validation; device privacy requires a device check.

### 06. Export and restore an encrypted backup — web only

**Use:** In Settings, enter the wallet password and export the encrypted backup. In a fresh browser profile, choose Restore wallet, select the encrypted-file option, upload the file and enter its password.

Settings also offers **Export public metadata** for inspecting public account information. That file contains no signing secret and is not a replacement for the recovery phrase or encrypted backup.

**Developer test:** Restored addresses must match. Wrong passwords, damaged files and oversized files must fail. The exported file must not contain readable recovery words or the password. Automated: Core browser and vault/security suites.

### 07. Reset the wallet on a device or browser — web and mobile

**Use:** Back up your recovery phrase first. In Settings, choose the wallet-removal/reset action, enter the password and acknowledge the backup requirement.

**Developer test:** Missing acknowledgment and wrong passwords must fail. A successful reset returns to onboarding. It must remove only that local wallet, not another browser profile, another device or blockchain holdings. Restore in a disposable profile to confirm recovery. Automated: Core and native lifecycle tests; manually check the native reset screen.

### 08. Manage accounts and recover additional accounts — web and mobile

**Use:** Open the account selector. Add a derived account and switch between accounts. On web, type a name and use the rename control. Web Settings also provides Derive public recovery candidates for supported discovery.

**Developer test:** Two derived account indexes must have different addresses. Switching must load the selected account's holdings. Renaming must not change its address. Discovery should find a funded higher account index without replacing the wallet root. Automated: EVM browser discovery; use the management browser test and manual device checks for selectors.

### 09. Select a network — web and mobile

**Use:** Open the network selector and choose the network required by your asset or recipient. The address may change when switching between EVM, Solana and Bitcoin.

**Developer test:** Check the selected network, address format, fee symbol and holdings after switching. A payment request for a different network must not be silently accepted. Bitcoin needs its public-descriptor watch enabled where requested. Automated: UI, EVM, Solana, Bitcoin and protocol suites.

### 10. View, search and hide balances — web and mobile

**Use:** Open Wallet, search for a token, refresh balances, select a token for details, or use the eye control to hide amounts.

**Developer test:** Search must filter correctly and show an empty result when appropriate. Hiding amounts must mask the display without changing balances. Compare raw balances with the local node. Disconnected/stale data must not appear as a fresh successful observation. Portfolio estimates and live market references are separate data sources. Automated: UI, management browser, public API and seed assertions.

### 11. Manage and import tokens — web only

**Use:** Choose Manage tokens. Hide/unhide a token or import a supported contract/mint using its full identifier and the requested metadata. Review the network before confirming.

**Developer test:** Use identifiers from the prepared deployment/asset manifests. Reject invalid identifiers, unsupported metadata and a missing acknowledgment. Hiding an asset must not transfer or destroy it. Unhiding should restore its visibility. Automated: UI token-import test and adapter/security tests; manually repeat against the actual local contract.

### 12. Receive assets and share a QR code — web and mobile

**Use:** Choose Receive, verify the account and network, then copy the address or share the displayed QR code/payment request. Bitcoin can provide a new receive address where offered.

**Developer test:** Decode the QR and compare the complete address, network and any requested amount with the screen. A new Bitcoin receive address must still belong to the same wallet. Automated: UI QR roundtrip, Bitcoin browser and derivation tests; scan the native QR on a device.

### 13. Read a QR code or payment request — web and mobile

**Use:** On web Send, upload a QR image or paste a payment request. On mobile, choose Scan and allow camera access, or paste the recipient address into Send.

**Developer test:** A valid request should fill the intended address/amount. A malformed or wrong-network request must show an error. On mobile, deny camera permission and confirm the app remains usable through manual entry. Automated: UI request parsing; physical camera behavior needs device testing.

### 14. Send crypto assets — web and mobile

**Use:** Choose Send, select an asset, enter the recipient and amount, review the full destination, network and maximum fee, then approve. Web also offers a fee-aware maximum amount.

**Developer test:** Compare sender/recipient balances and the node receipt after a small send. Reject zero/negative/oversized amounts, invalid recipients, insufficient fees and expired/changed reviews. Rejecting a review must move no assets. Automated: EVM, Solana, Bitcoin and native-core chain suites.

Supported coverage includes EVM native/ERC-20 transfers, Solana SOL/SPL/Token-2022 transfers and Bitcoin SegWit/Taproot payments. Support varies by network; do not assume every token or arbitrary contract is supported.

### 15. Review activity, receipts and saved submissions — web and mobile

**Use:** Open Activity. Web provides filters and transaction details; both clients can load older activity where available. Mobile offers Retry saved transaction for eligible uncertain submissions.

**Developer test:** Confirm the correct account/network, transaction ID, amount, fee and status. A submitted transaction is not yet confirmed. Repeated retries must reuse saved signed bytes, not create a new payment. Reorgs must remove orphaned inclusion claims. Automated: Browser-chain tests, native journal tests, integration and failure scenarios.

### 16. View and transfer collectibles — web and mobile

**Use:** Open Collectibles, choose an owned item, inspect it and enter the recipient for a supported transfer. Review before approving. Web can request permitted external metadata/media.

**Developer test:** Confirm ownership on the node before and after sending. Unowned/unsupported items must not be transferable. Blocked or malformed remote metadata must not execute scripts or expose local services. Automated: EVM/Solana browser transfers, native EVM proof and metadata-security tests. Manually check native collectible screens.

### 17. Save, edit and delete contacts — web only

**Use:** Open Address book, enter a Contact label and Full address, then save. Use Edit or Delete next to a saved contact. Contacts belong to their selected network.

**Developer test:** Add a contact, rename it, choose it in Send, switch networks and confirm it is not offered on the wrong network, then delete it. The address must not change when only its label changes. Automated: Management browser test.

### 18. Swap tokens — web and mobile

**Use:** Select Local Ethereum and open Swap. Enter the input amount, request a quote, inspect the minimum received and slippage, approve the exact allowance if required, then obtain a fresh quote and review the swap.

**Developer test:** Confirm input/output balances against the local pool. Expired quotes, excessive slippage and insufficient balances must fail. An allowance is a separate transaction and must not itself execute the swap. Automated: EVM contract/browser and native EVM chain tests.

### 19. Claim from a faucet — web only

**Use:** Open Network tools, choose Faucet, check the claim amount, cooldown and remaining claims, then review the claim.

**Developer test:** Confirm the token balance increase. An immediate second claim should be unavailable or rejected until eligible. The maximum claim count must be enforced by the contract. Automated: EVM browser and contract suites.

### 20. Deposit and withdraw from a savings vault — web only

**Use:** Open Network tools → Savings vault. Choose the amount and duration, approve an allowance if needed, and review the deposit. Withdraw only after the displayed position becomes eligible.

**Developer test:** Early withdrawals must fail. After chain time reaches the unlock time, the principal can be withdrawn once. The vault does not promise yield. Automated: Contract and EVM browser suites. Use disposable chain state for time-manipulation tests.

### 21. Use a two-of-three shared wallet — web only

**Use:** Restore an owner wallet such as Alice, open Shared wallet and create a proposal. Open Bob's separate owner wallet in another browser profile. Obtain two distinct owner approvals, then review execution.

**Developer test:** One owner cannot count twice. A non-owner cannot approve. Execution must stay blocked below two approvals and cannot pay twice. An owner can revoke their approval before execution. Automated: Contract and EVM shared-wallet browser tests.

### 22. Bridge between local networks — web only

**Use:** Open Bridge on Local Ethereum. Enter an amount and review the source lock. Keep the trusted local relayer running; it observes the lock and mints the destination asset. Switch to the destination network to inspect the result.

**Developer test:** Source lock and destination mint must refer to the same message. Replaying it must not mint twice. Withholding the relayer should show a waiting/timeout state, not success. There is no automatic refund guarantee. Automated: Bridge contract/browser tests and relayer-timeout scenario.

### 23. Connect applications and manage permissions — web only

**Use:** Restore the testing wallet separately at port 8787. Open the reference application at port 5174, select a chain family and Connect. Unlock the approval window, inspect its origin/account/network and approve or reject. Later, review Connected apps to revoke access or supported token authorizations.

After connecting, try **Sign message** in the reference application. Unlock its new approval window, review the request and approve the signature. For EVM, **Send 0.001 ETH** requests a payment through another explicit review. Rejecting either request must leave it unsigned. A message signature does not itself send assets.

**Developer test:** Connection alone must not sign a payment. Every signature/transaction needs its own review. Wrong origins, channels, accounts, networks and replayed requests must fail. Disconnecting must revoke the live connection. Automated: EVM, Solana and Bitcoin popup suites plus protocol/security tests. Native external dapp connections are not implemented.

### 24. View live market references — web and mobile

**Use:** Open Discover or Market watch, view the available BTC/ETH/SOL prices and refresh. Check the observation time when shown.

**Developer test:** Available prices must come from the configured external provider. A provider outage must produce an unavailable/stale state, not fabricated fresh quotes. Do not use these quotes to infer a monetary value for seeded assets. Automated: Market-security tests; optional live-provider check in section 5.

### 25. Search actions and view notifications — web only

**Use:** Click Search wallet or press Ctrl+K/Cmd+K, then find an asset/action. Open the bell for transaction notifications; select a notification to inspect activity.

**Developer test:** Keyboard navigation and closing the search must work. Empty notifications should show the empty state. Search results should navigate to the intended screen. Automated: Product UI and accessibility suite.

### 26. Sign in and out of an account — web only

**Use:** Open `/accounts`. Sign in using the generated `alice`, `bob`, `admin` or `auditor` credentials. Use Sign out when finished.

**Developer test:** Wrong credentials must fail. Sign-out and expiry must invalidate access. Repeated failures must be throttled. A login request cannot assign itself a role. Automated: Accounts browser and security suites.

### 27. Transfer account credits — web only

**Use:** Sign Alice and Bob in separately. As Alice, select Bob, enter 25.15 credits, review and confirm. Refresh Bob's balance and compare the matching receipt.

**Developer test:** Alice decreases by 25.15 and Bob increases by 25.15. Their combined balance stays constant. An interrupted-response retry must not debit twice. Reject self-transfers, overdrafts and invalid amounts. Automated: Accounts browser/security suites. These are SQLite credits, not blockchain transactions.

### 28. Apply Admin and Auditor permissions — web only

**Use:** As Member, use Check admin permission to see the denied request. As Admin, inspect all activity and suspend/re-enable a Member. As Auditor, inspect reports and use Check transfer permission.

**Developer test:** Member admin access and Auditor transfers/account changes must return 403. Suspending Alice must revoke her existing sessions immediately. Re-enabling preserves her balance/history. No role may forge another sender. Automated: Accounts browser/security suites.

## 5. Run the developer tests

### The complete local suite

First prepare the dependencies and local dataset using Option B. Then **stop development servers and Metro** so test servers can own their ports. Do not run two chain-testing commands at once.

```sh
pnpm test:all:local
```

The runner performs the checks sequentially, writes a log for every check, and stops at a failure. Read **`.local/reports/full-suite/report.json`** for the current result and the relevant log under **`.local/reports/full-suite/logs/`**. Fix the reported problem and run again. It does not reset your main ledgers or send public-network funds.

For a fix confined to the failed check or its environment, `pnpm test:all:local --resume` can continue in the same Git checkout. It retains earlier passing results only when the application/dependency fingerprint matches, and archives the failed attempt. If application code or any earlier passed test changed, run the full command without `--resume`.

The **real-funds-stay-disabled** check intentionally expects exit code 1: that confirms activation is blocked. Other checks normally expect exit code 0. The report records the expected and actual codes.

The Android package check needs a complete JDK and Android SDK. On Linux, if necessary:

```sh
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME="$HOME/Android/Sdk"
pnpm test:all:local
```

Chrome defaults to `/opt/google/chrome/chrome`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if installed elsewhere. Check the phone-installation guide for platform setup. An Android/iOS JavaScript bundle is not proof that the app ran on a physical phone.

### Run one area when fixing a problem

- **Unit/security:** `pnpm test:unit` — amounts, derivation, encrypted vaults, sessions, CSRF, permissions, requests, metadata, journals and adapters.
- **Wallet UI:** `pnpm build:web`, then `pnpm test:ui` — navigation, payment review/rejection, QR parsing, token import, contacts/accounts management, product wording, accessibility and responsive layouts. These tests use the real built wallet and node-backed balances.
- **Core browser:** `pnpm build:wallet`, then `pnpm test:browser-core` — actual signing Worker, onboarding, backup restore, password changes and cross-window locking.
- **EVM browser:** `pnpm exec playwright test --config playwright.chains.config.ts` — actual local EVM payments, collectibles, services, shared ownership, maximum fees, bridge and discovery.
- **EVM popup:** `pnpm exec playwright test --config playwright.dapp.config.ts` — built-wallet connections and explicit approvals.
- **Solana browser/popup:** `pnpm test:browser-solana` — creates its own temporary validator and checks SOL, SPL, Token-2022, collectibles and connections.
- **Bitcoin browser/popup:** `pnpm test:browser-bitcoin` — creates its own temporary regtest node and checks SegWit/Taproot payments, change, confirmations and connections.
- **Accounts:** `pnpm test:accounts` — two users, credits, roles, suspension, reports and responsive/accessibility checks in a disposable database.
- **Contracts:** `pnpm contracts:test` — contract access control, cooldowns, lock times, shared approvals and bridge replay protection.
- **Backend/indexing:** `pnpm test:integration` — public API isolation, indexed activity, state reconciliation and reorg recovery.
- **Native core:** `pnpm mobile:test:chains` — native signing logic against real local nodes. These are Node-hosted core tests, not native UI/device tests.
- **Native build:** `pnpm mobile:typecheck`, `pnpm mobile:export`, then `pnpm mobile:build:android` — native TypeScript, both Hermes bundles and Android debug APK compilation.
- **Dependency audit:** `pnpm audit:verified` — retains the raw advisory report and verifies the documented security backport before applying its mitigation.
- **Dataset:** `pnpm seed:assert` — compares prepared balances/holdings with actual nodes without sending payments.

Build commands share `apps/wallet/dist`. Build the local wallet before running browser tests; after testing a testnet build, restore it with `pnpm build:wallet`. Solana/Bitcoin browser commands manage their own temporary nodes. They must run sequentially, with port 8787 available.

### Failure and recovery scenarios

With other development/test servers stopped, run:

```sh
pnpm scenario -- pending-evm
pnpm scenario -- replacement-evm
pnpm scenario -- reverted-evm
pnpm scenario -- reorg-evm
pnpm scenario -- rpc-outage
pnpm scenario -- relayer-timeout
```

Expected result: correct pending/replaced/reverted/orphaned/unavailable/waiting behavior; no false confirmation or duplicate payment. The scenario scripts restore their local EVM snapshot and automining settings. Do not send your own transactions while they run.

Optional external connectivity checks:

```sh
pnpm networks:check
pnpm exec tsx scripts/check-market-live.ts
```

An unavailable public RPC, faucet or price provider must be recorded as unavailable. Public-network transaction coverage requires funded testing identities and is separate from successful local tests.

## 6. Complete the phone checklist

Run this on **an actual Android phone and an actual iPhone** before claiming device acceptance:

1. Install through the phone guide and open the app with the intended backend.
2. Create a disposable wallet; complete backup verification.
3. Lock/unlock, force-close/reopen, background/resume and wait for inactivity locking.
4. Restore the same testing phrase and compare public addresses with the web wallet.
5. Check balances/search/privacy, receive QR, camera scan and camera-permission denial.
6. Send a small amount for each supported family and compare node receipts.
7. Check a supported collectible transfer and an EVM swap.
8. Disconnect the API during refresh/submission; inspect errors and saved-transaction retry behavior without creating a duplicate payment.
9. Change password, reveal/hide recovery words, check the reveal timeout, screenshots and app-switcher privacy.
10. Reset the disposable device wallet and restore it again.

Record phone model, OS version, app version, result and any error. Native biometric unlock, external dapp protocols, web Accounts login and all web contract tools are not implemented as native features. Do not count them as passed device tests.

## 7. Common problems

- **The page looks like a connection tool:** You opened port 5174. Open the wallet at port 5173.
- **The wallet is empty:** A new phrase creates new addresses. Restore the prepared Alice testing phrase if you need the seeded holdings.
- **Balances belong to another network:** Check both the account selector and network selector.
- **Sending a token fails despite a token balance:** The sender may lack the native asset required for the network fee.
- **A second login replaces the first:** Use independent browser profiles rather than two tabs sharing cookies.
- **You forgot the crypto-wallet password:** Restore from your recovery phrase in a fresh browser profile/device and choose a new password. There is no email reset for a self-custody wallet. An encrypted backup file still needs its own password.
- **Accounts are unavailable:** Stop the existing server and start `pnpm dev:accounts`, or use `EWALLET_ACCOUNTS=1 pnpm dev` for the complete environment.
- **The app cannot reach the backend:** Android needs ADB port reversal for the documented USB setup. A physical iPhone needs a reachable HTTPS API.
- **A test says a port is occupied:** Stop the existing development/Metro/test process. Do not reset Docker volumes to solve a port conflict.
- **After tests, screens look different:** Run `pnpm build:wallet` and restart the intended development command. Local and testnet builds share an output directory.

## 8. What a successful test run means

Read the current [full-suite report](.local/reports/full-suite/report.json) for the exact check counts, results and limitations. The report is generated by `pnpm test:all:local`; it is not shipped as source evidence.

A passing report means the listed checks passed on that revision and environment. It does not prove that every possible bug is absent. Keep a failing log, steps to reproduce and the affected platform when reporting a problem.

The full-suite report distinguishes automated passes, external-service limitations and checks requiring a phone or macOS. Physical-device acceptance and the iOS native build cannot be inferred from unit tests or JavaScript bundles. Future real-fund launch requirements remain in [README.md](README.md#deployment-and-real-fund-activation).

After testing, restart the project:

```sh
EWALLET_ACCOUNTS=1 pnpm dev
```

For a short account walkthrough, follow features **26 → 27 → 28**. For the crypto wallet, follow **02 → 10 → 12 → 14 → 15**.
