# e-wallet web connector

This SDK connects an integrating top-level website to a separately hosted e-wallet website. It never injects another wallet's provider or claims an extension identity. Use HTTPS, or the explicit development origins `http://127.0.0.1:5174` and `http://127.0.0.1:8787`.

```ts
import {createEWalletConnector, registerEWalletSolana} from '@ewallet/provider';
const connector = createEWalletConnector({walletUrl:'http://127.0.0.1:8787/'});
const {wallet:solanaWallet} = registerEWalletSolana(connector);
connectButton.onclick = () => {
  void connector.connect('evm').then(showApprovedAccounts).catch(showError);
};
connector.on('approvalRequired', () => showOpenApprovalButton());
openApprovalButton.onclick = () => connector.openApproval();
openTabButton.onclick = () => connector.openApproval({asTab:true});
```

Call signing methods directly from a user click; each opens a fresh approval window. If a browser blocks it, show an explicit retry button. Do not pass request data in URLs or use an unbound redirect fallback. Keep the initial connection window open for lock/revoke/account events; closing it clears the live SDK session. Grants expire after 24 hours. Each signature/send requires separate unlock and approval.

## EVM

`connector.evm.request({method,params})`, `on(event,listener)`, and `removeListener(event,listener)` provide the EIP-1193 interface. Supported methods: `eth_requestAccounts`, grant-filtered `eth_accounts`, `eth_chainId`, `wallet_switchEthereumChain`, `eth_sendTransaction`, `personal_sign`, and `eth_signTypedData_v4`. Chain addition, `eth_sign`, unknown selectors, unlimited allowances and trailing/noncanonical calldata are rejected. Token calls must decode to a supported exact transfer/approval/NFT action. Typed-data previews include the exact domain and structured message; the domain chain must match.

```ts
sendButton.onclick = () => {
  void connector.evm.request({method:'eth_sendTransaction',params:[{
    from:approvedAddress,to:recipient,value:'0x38d7ea4c68000',chainId:'0x7a69'
  }]}).then(showTransactionHash).catch(showError);
};
```

Errors use conventional codes: 4001 rejection/expiry, 4100 unauthorized, 4200 unsupported, 4900 disconnected, 4901 wrong chain. `accountsChanged`, `chainChanged`, `connect` and `disconnect` are emitted for relevant session changes. Changing the selected account/network requires new consent; another address is never silently shared.

## Solana Wallet Standard

`registerEWalletSolana(connector)` registers `e-wallet Web` inside the integrating dapp. It implements `standard:connect`, `standard:disconnect`, `standard:events`, `solana:signMessage`, `solana:signTransaction` and `solana:signAndSendTransaction`. Local SDK network `solana:local` maps to Wallet Standard `solana:localnet`.

```ts
solanaConnectButton.onclick = () => {
  void solanaWallet.features['standard:connect'].connect().then(showAccounts);
};
solanaSendButton.onclick = () => {
  void solanaWallet.features['solana:signAndSendTransaction']
    .signAndSendTransaction({account,chain:'solana:localnet',transaction:unsignedBytes})
    .then(showSignature).catch(showError);
};
```

External messages support one completely decoded positive native System transfer, optional bounded compute-budget instructions and a short UTF-8 Memo. Legacy/v0 single-payer transactions are supported. Unknown programs, token instructions, durable nonce accounts, lookup tables, additional signers, pre-existing signatures and custom execution options are refused. The wallet preserves the exact supplied bytes and recent blockhash; expiry requires the dapp to prepare a new transaction. One input is accepted per signing action.

## Bitcoin project API

This is a project API, not a universal Bitcoin standard:

```ts
connector.bitcoin.getAccounts();
connector.bitcoin.getNetwork();
connector.bitcoin.signPsbt(base64Psbt, internalChangeIndex);
connector.bitcoin.broadcastTransaction(signedTransactionHex);
connector.bitcoin.disconnect();
```

`signPsbt` returns `{psbt,transaction,txid,networkId}` after review and does not broadcast. The finalized PSBT is authorization data: keep it in memory, return it only to the bound requester, and do not log or send it to telemetry. Broadcast requires a separate review and accepts only the exact transaction previously signed for this origin/account/network.

The initial policy is regtest P2WPKH/P2TR, 1–10 distinct owned confirmed inputs, version 2/locktime 0/sequence `0xfffffffe`, one recipient first, and optional internal change second. Supply its internal index explicitly; the wallet derives the script independently. It verifies every previous output against Core data, dust/fee bounds, and `SIGHASH_ALL` for SegWit or `SIGHASH_DEFAULT` for Taproot. Extra PSBT fields and arbitrary sighash policies are refused. Public descriptor discovery requires explicit consent in the wallet.

## Transport limits

Messages bind version 1, an unpredictable 32-byte channel nonce, UUID request ID, exact configured origin and exact returned window. A challenge/ack verifies the opener before approval. Requests expire after two minutes; chain previews expire sooner. Limits: 128 KiB transport, 16 KiB signed messages, one active request and five queued requests. Refresh/close/navigation cancels pending consent. Only grant metadata and public deduplication IDs persist.

The reference dapp includes controlled wrong-channel/target-origin/tamper/replay/unsupported-network cases. Actual popup tests are in `tests/browser-dapp/`; SDK binding/queue tests are in `tests/security/provider.test.ts`. Call `connector.dispose()` when the integration unmounts.
