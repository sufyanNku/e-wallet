# Classroom demo: two logins, transfers and RBAC

The interface uses ordinary account and credit labels for the presentation. Its underlying ledger is still for testing; real-fund activation remains disabled.

This guide covers the **web classroom demo** at `http://127.0.0.1:5173/accounts`.
It uses **demo credits recorded in SQLite**, not real money or on-chain crypto.
No recovery phrase, faucet, gas or Docker node is needed for this demonstration.
The existing self-custody crypto wallet remains available separately. Native Android/iOS username login is not part of this feature.

## 1. Prepare your teammate's computer

Open a terminal inside the project folder. Use the pinned pnpm version, **10.34.9**.
The workspace automatically selects Node **24.22.3** for pnpm commands.

```sh
git pull --ff-only
pnpm install --frozen-lockfile
pnpm node --version
pnpm build:wallet
pnpm demo:setup
```

Setup creates these accounts:

- `alice` — **Member**, initially 1,000.00 demo credits.
- `bob` — **Member**, initially 1,000.00 demo credits.
- `admin` — **Admin**, initially 0.00 demo credits.
- `auditor` — **Auditor**, initially 0.00 demo credits.

Each account gets a different randomly generated password. Open this ignored local file to see them:

```sh
cat .local/local/team-demo-credentials.json
```

Copy the `password` belonging to the username you want. Do not use a recovery phrase as the password. Do not commit or share the credentials file publicly. Your teammate must run setup on their computer; this ignored file is not downloaded with the repository.

Running `pnpm demo:setup` again **preserves existing passwords, balances, history and account suspension status**. It does not refill accounts. If you configured `EWALLET_DATABASE_PATH`, the credential file is next to that database instead.

## 2. Start the demo

Stop any previous `pnpm dev` with **Ctrl+C** in its terminal, then run:

```sh
pnpm demo:dev
```

Open **http://127.0.0.1:5173/accounts**.

You can also select **Sign in to your account** on the wallet welcome page, or **Accounts** in the wallet sidebar.

The command enables `EWALLET_TEAM_DEMO=1` for this process. Ordinary `pnpm dev` leaves the classroom API disabled. If the existing backend is still running without that flag, startup tells you to stop it first.

The dev launcher may report that blockchain nodes need starting or seeding. Those messages concern the separate crypto wallet; the SQLite classroom demonstration works without the nodes.

Use the exact `127.0.0.1` address above. Cookies, allowed origins and browser storage depend on the origin. Port **5174** is the developer reference dapp, not this demo.

## 3. Show two users transferring credits

Use **one normal browser window and one incognito/private window**, or two separate browser profiles. Two normal tabs share the same login. Multiple incognito windows may also share one incognito session.

1. In the normal window, open `/accounts` and sign in as `alice`, using Alice's generated password.
2. In the private window, open the same URL and sign in as `bob`, using Bob's password.
3. Show the **Member** role and each user's available demo credits.
4. In Alice's window, choose **Bob (@bob)** under **Recipient**.
5. Enter **25.15** under **Amount in credits**.
6. Click **Review transfer**, check the recipient and amount, then click **Confirm transfer**.
7. Show the success receipt and Alice's updated balance.
8. In Bob's window, click **Refresh balances**. His balance and incoming transfer appear. The page also refreshes automatically about every five seconds while visible.

For freshly prepared accounts, the result is:

- Alice: **974.85** demo credits.
- Bob: **1,025.15** demo credits.
- Both histories show **Alice → Bob**, the amount, timestamp and the same receipt ID.

Bob can send credits back by choosing Alice and following the same review/confirm steps. If accounts have already been used, compare the balance changes rather than expecting the fresh starting values.

**Roman Urdu presentation script:**

> Normal window mein Alice login hai aur incognito mein Bob. Alice se Bob ko 25.15 demo credits bhejte hain. Confirm karne ke baad Alice ka balance kam aur Bob ka balance utna hi zyada hota hai. Dono ko same transfer receipt nazar aati hai. Yeh SQLite demo ledger hai; real paisay ya blockchain transfer nahin.

## 4. Demonstrate RBAC to the evaluator

**Member restrictions**

While signed in as Alice or Bob, click **Check admin permission**. The UI makes a real request to the administrative API. The backend returns **403**, shown on screen. Members can see only transfers involving their own account; another user's balance and unrelated transfers are not returned to Members.

**Admin oversight and suspension**

1. Use a third browser profile, or sign out in Bob's window, then sign in as `admin`.
2. Show **Account oversight**, **All transfers** and **Audit trail**.
3. Click **Suspend Alice**.
4. In Alice's window, click **Refresh balances**. Alice is signed out; the server has revoked her demo sessions. A suspended user cannot log in or transfer.
5. As Admin, click **Enable Alice**.
6. Sign Alice in again. Her balance and history are preserved.

Admin can suspend/re-enable **Member** accounts. Admin cannot change anyone's password, impersonate a Member, or edit balances through an API. Account roles are assigned by the local setup command; the login request cannot choose or upgrade a role.

**Auditor read-only access**

1. Sign out of Admin and sign in as `auditor`.
2. Show the all-account report, transfer history and audit trail.
3. Show that Member suspension controls are absent.
4. Click **Check transfer permission**. The backend returns **403** and no credits move.

> Member transfer kar sakta hai lekin admin report nahin khol sakta. Admin activity dekh sakta hai aur Member ko suspend kar sakta hai. Auditor sirf reports dekh sakta hai; backend us ka transfer reject karta hai. Yeh restrictions sirf buttons hide karne se nahin, server par bhi enforce hoti hain.

## 5. What is enforced

- Passwords use a unique random salt and Node's scrypt password hashing; plaintext login passwords are not stored in the database.
- Login uses an HttpOnly, SameSite=Strict cookie, linked to the existing browser session and limited to 30 minutes or the underlying session's earlier expiry.
- State-changing requests require the allowed origin, JSON, browser fetch metadata and a valid CSRF token.
- Roles and account status are read from the database on every protected request. Changing a request body or browser storage cannot assign Admin privileges.
- Debit, credit, receipt and transfer audit event are committed together in one SQLite transaction. Insufficient funds, negative/zero amounts, extra decimal places, self-transfers and suspended recipients are rejected.
- Each reviewed transfer has a request ID. Retrying that request returns its existing receipt instead of making a second debit; changing the amount or recipient under the same ID is rejected.
- Account suspension invalidates existing demo sessions immediately. Login failures are throttled; after five failures against one account, wait one minute.
- The feature is off by default and refuses production mode, public-testnet mode and non-loopback server binding.

These are application permissions for a local demonstration, not a production custody or real-money banking system. Administrator access to the computer/database itself is outside this demo's permission boundary.

## 6. Troubleshooting and checks

- **“Account service is unavailable” appears:** Stop the old server, run `pnpm demo:setup`, then `pnpm demo:dev`.
- **Port 5173/8787 is occupied:** Stop the earlier project terminal before restarting. Do not run two dev launchers on the same ports.
- **Login fails:** Check the matching username/password in the local credential file. Check whether Admin suspended the Member. Wait one minute after repeated failed attempts.
- **Alice and Bob become the same user:** Their browser windows share cookies. Use a separate browser profile or one normal window plus one private window.
- **Session expired:** Sign in again; after the underlying browser session expires, reload the page first. Balances and history persist.
- **Balance is not 1,000.00:** Setup is intentionally idempotent. Previous transfers are preserved. Show the before/after difference or transfer credits back.
- **Changed frontend code is missing on port 8787:** Run `pnpm build:wallet`; port 8787 serves the built client. Port 5173 serves the development client.

Run the focused automated checks:

```sh
pnpm typecheck
pnpm lint
pnpm exec vitest run tests/security/team-demo.test.ts --reporter=default
pnpm test:demo
```

The browser test creates its own disposable database under `.local/team-demo-browser/` and uses port **8877**. It does not transfer credits from your presentation accounts. The default test runner expects Chrome at `/opt/google/chrome/chrome`; use `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to point to your installation if needed.

Implementation references: [Node.js scrypt API](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) and [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
