import { protocolProbe } from "./probes";
import {
  address,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import {
  createEWalletConnector,
  registerEWalletSolana,
} from "@ewallet/provider";
import "./style.css";
const connector = createEWalletConnector({
  walletUrl:
    import.meta.env.VITE_EWALLET_APPROVAL_URL ?? "http://127.0.0.1:8787/",
});
const walletUrl =
  import.meta.env.VITE_EWALLET_WALLET_URL ?? "http://127.0.0.1:5173/";
const { wallet: solanaWallet } = registerEWalletSolana(connector);
function App() {
  const [family, setFamily] = useState<"evm" | "solana" | "bitcoin">("evm"),
    [accounts, setAccounts] = useState<string[]>([]),
    [network, setNetwork] = useState(""),
    [result, setResult] = useState(""),
    [recipient, setRecipient] = useState(""),
    [message, setMessage] = useState("Hello from the e-wallet reference dapp."),
    [payload, setPayload] = useState(""),
    [pending, setPending] = useState(false);
  useEffect(() => {
    const update = () => {
      const session = connector.getSession(family);
      setAccounts(session?.accounts ?? []);
      setNetwork(session?.networkId ?? "");
    };
    update();
    const off1 = connector.on("sessionChanged", update),
      off2 = connector.on("sessionDisconnected", update),
      off3 = connector.on("approvalRequired", () => setPending(true));
    return () => {
      off1();
      off2();
      off3();
    };
  }, [family]);
  function run(promise: Promise<unknown>) {
    setResult("Awaiting wallet approval…");
    void promise
      .then((value) => {
        setResult(JSON.stringify(value, null, 2));
        if (
          value &&
          typeof value === "object" &&
          "transaction" in value &&
          typeof value.transaction === "string"
        )
          setPayload(value.transaction);
        const session = connector.getSession(family);
        setAccounts(session?.accounts ?? []);
        setNetwork(session?.networkId ?? "");
      })
      .catch((e) => setResult(`Rejected (${e.code ?? "error"}): ${e.message}`));
  }
  async function prepareSolana() {
    const response = await fetch("/reference/solana/blockhash"),
      body = await response.json();
    if (!response.ok) throw new Error(body.error);
    const m = appendTransactionMessageInstructions(
      [
        getTransferSolInstruction({
          source: createNoopSigner(address(accounts[0])),
          destination: address(recipient),
          amount: 10000n,
        }),
      ],
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(body.data.value.blockhash),
          lastValidBlockHeight: BigInt(body.data.value.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          address(accounts[0]),
          createTransactionMessage({ version: 0 }),
        ),
      ),
    );
    const encoded = getTransactionEncoder().encode(compileTransaction(m));
    const result = btoa(
      Array.from(encoded, (b) => String.fromCharCode(b)).join(""),
    );
    setPayload(result);
    return { prepared: true, amount: "10000", recipient };
  }
  async function prepareBitcoin() {
    const response = await fetch(
        "/reference/bitcoin/psbt?address=" + encodeURIComponent(accounts[0]),
      ),
      body = await response.json();
    if (!response.ok) throw new Error(body.error);
    setPayload(body.data.psbt);
    return {
      prepared: true,
      amount: body.data.amount,
      recipient: body.data.recipient,
    };
  }
  function sign() {
    const bytes = new TextEncoder().encode(message),
      hex =
        "0x" +
        Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    run(
      family === "evm"
        ? connector.evm.request({
            method: "personal_sign",
            params: [hex, accounts[0]],
          })
        : solanaWallet.features["solana:signMessage"].signMessage({
            account: solanaWallet.accounts[0],
            message: bytes,
          }),
    );
  }
  return (
    <main>
      <aside className="wallet-entry" aria-label="Open the wallet application">
        <div>
          <strong>This is the connection reference app.</strong>
          <p>
            Looking for the dark wallet? Open the wallet application using the
            link below.
          </p>
        </div>
        <a href={walletUrl} target="_blank" rel="noopener noreferrer">
          Open wallet ↗
        </a>
      </aside>
      <p className="eyebrow">CONNECTION REFERENCE</p>
      <h1>
        A separate site.
        <br />
        An explicit approval.
      </h1>
      <p>
        This site uses the e-wallet connector. The wallet opens at its own
        origin and holds the signing keys.
      </p>
      <nav aria-label="Chain family">
        {(["evm", "solana", "bitcoin"] as const).map((f) => (
          <button
            key={f}
            aria-pressed={family === f}
            onClick={() => setFamily(f)}
          >
            {f.toUpperCase()}
          </button>
        ))}
      </nav>
      <section>
        <h2>{family.toUpperCase()} connection</h2>
        <button
          onClick={() =>
            run(
              family === "solana"
                ? solanaWallet.features["standard:connect"].connect()
                : connector.connect(family),
            )
          }
        >
          Connect {family}
        </button>
        <button onClick={() => run(connector.disconnect(family))}>
          Disconnect {family}
        </button>
        <dl>
          <dt>Network</dt>
          <dd data-testid="network">{network || "Disconnected"}</dd>
          <dt>Public accounts</dt>
          <dd data-testid="accounts">{accounts.join(", ") || "None shared"}</dd>
        </dl>
        {pending && (
          <button
            onClick={() => {
              connector.openApproval();
              setPending(false);
            }}
          >
            Open wallet approval
          </button>
        )}
        <button onClick={() => connector.openApproval({ asTab: true })}>
          Open approval as tab
        </button>
      </section>
      <section>
        <h2>Request an operation</h2>
        {family !== "bitcoin" && (
          <>
            <label>
              Message
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <button onClick={sign}>Sign message</button>
          </>
        )}
        {family === "evm" && (
          <>
            <label>
              Recipient
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </label>
            <button
              onClick={() =>
                run(
                  connector.evm.request({
                    method: "eth_sendTransaction",
                    params: [
                      {
                        from: accounts[0],
                        to: recipient,
                        value: "0x38d7ea4c68000",
                        chainId:
                          "0x" +
                          BigInt(network.split(":")[1] ?? "31337").toString(16),
                      },
                    ],
                  }),
                )
              }
            >
              Send 0.001 ETH
            </button>
            <button
              onClick={() =>
                run(
                  connector.evm.request({
                    method: "eth_signTypedData_v4",
                    params: [
                      accounts[0],
                      JSON.stringify({
                        domain: {
                          name: "Reference dapp",
                          version: "1",
                          chainId: network.split(":")[1] ?? "31337",
                        },
                        types: { Message: [{ name: "text", type: "string" }] },
                        primaryType: "Message",
                        message: { text: message },
                      }),
                    ],
                  }),
                )
              }
            >
              Sign typed message
            </button>
            <button
              onClick={() =>
                run(
                  connector.evm.request({
                    method: "wallet_switchEthereumChain",
                    params: [{ chainId: "0x7a6a" }],
                  }),
                )
              }
            >
              Switch to local EVM B
            </button>
          </>
        )}
        {family === "solana" && (
          <>
            <label>
              Solana recipient
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </label>
            <button onClick={() => run(prepareSolana())}>
              Prepare 0.00001 SOL transfer
            </button>
            <label>
              Unsigned transaction (base64)
              <textarea
                aria-label="Unsigned transaction (base64)"
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
              />
            </label>
            <button
              onClick={() =>
                run(
                  connector.request("solana", "solana:signTransaction", [
                    { transaction: payload },
                  ]),
                )
              }
            >
              Sign transaction
            </button>
            <button
              onClick={() =>
                run(
                  connector.request("solana", "solana:signAndSendTransaction", [
                    { transaction: payload },
                  ]),
                )
              }
            >
              Sign and send transaction
            </button>
          </>
        )}
        {family === "bitcoin" && (
          <>
            <button onClick={() => run(prepareBitcoin())}>
              Prepare 0.0001 BTC payment
            </button>
            <label>
              PSBT (base64) or signed transaction (hex)
              <textarea
                aria-label="PSBT (base64) or signed transaction (hex)"
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
              />
            </label>
            <button onClick={() => run(connector.bitcoin.signPsbt(payload, 0))}>
              Sign PSBT
            </button>
            <button
              onClick={() =>
                run(connector.bitcoin.broadcastTransaction(payload))
              }
            >
              Broadcast transaction
            </button>
          </>
        )}
      </section>
      <section>
        <h2>Development refusal cases</h2>
        <button onClick={() => run(protocolProbe("connect"))}>
          Protocol connect (record ID)
        </button>
        <button onClick={() => run(protocolProbe("wrong-channel"))}>
          Wrong channel probe
        </button>
        <button onClick={() => run(protocolProbe("wrong-target-origin"))}>
          Wrong target origin probe
        </button>
        <button onClick={() => run(protocolProbe("tampered"))}>
          Tamper active request
        </button>
        <button onClick={() => run(protocolProbe("replay"))}>
          Replay last request ID
        </button>
        <p>These requests must fail without signing.</p>
        <button
          onClick={() =>
            run(
              connector.evm.request({
                method: "eth_sign",
                params: [accounts[0], "0x00"],
              }),
            )
          }
        >
          Unknown method
        </button>
        <button
          onClick={() =>
            run(
              connector.evm.request({
                method: "eth_sendTransaction",
                params: [
                  {
                    from: accounts[0],
                    to: recipient,
                    value: "0x1",
                    chainId: "0x1",
                  },
                ],
              }),
            )
          }
        >
          Wrong network
        </button>
        <button
          onClick={() =>
            run(
              connector.evm.request({
                method: "eth_sendTransaction",
                params: [
                  { from: accounts[0], to: recipient, data: "0xdeadbeef" },
                ],
              }),
            )
          }
        >
          Unknown calldata
        </button>
      </section>
      <section>
        <h2>Public result</h2>
        <pre role="status" data-testid="result">
          {result || "No request yet."}
        </pre>
      </section>
      <footer>
        Bitcoin support is a project API. Solana uses Wallet Standard. No
        injected extension is claimed.
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
