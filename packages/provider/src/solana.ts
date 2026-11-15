import { registerWallet } from "@wallet-standard/wallet";
import type { WalletAccount, WalletWithFeatures } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
  StandardEventsChangeProperties,
} from "@wallet-standard/features";
import type {
  SolanaSignMessageFeature,
  SolanaSignTransactionFeature,
  SolanaSignAndSendTransactionFeature,
} from "@solana/wallet-standard-features";
import { base58, base64, hex } from "@scure/base";
import { z } from "zod";
import { EWalletProviderError, type EWalletConnector } from "./index";
type Features = StandardConnectFeature &
  StandardDisconnectFeature &
  StandardEventsFeature &
  SolanaSignMessageFeature &
  SolanaSignTransactionFeature &
  SolanaSignAndSendTransactionFeature;
export function registerEWalletSolana(connector: EWalletConnector) {
  const listeners = new Set<(value: StandardEventsChangeProperties) => void>();
  const chain = (network: string) =>
    network === "solana:local" ? "solana:localnet" : network;
  const features = [
    "solana:signMessage",
    "solana:signTransaction",
    "solana:signAndSendTransaction",
  ] as const;
  let accounts: readonly WalletAccount[] = [];
  function update() {
    const session = connector.getSession("solana");
    accounts = Object.freeze(
      (session?.accounts ?? []).map((address) =>
        Object.freeze({
          address,
          publicKey: base58.decode(address),
          chains: Object.freeze([
            chain(session!.networkId) as "solana:localnet" | "solana:devnet",
          ]),
          features,
          label: "e-wallet account",
        }),
      ),
    );
    for (const listener of listeners) listener({ accounts });
  }
  const off1 = connector.on("sessionChanged", (family) => {
      if (family === "solana") update();
    }),
    off2 = connector.on("sessionDisconnected", (family) => {
      if (family === "solana") update();
    });
  function authorized(account: WalletAccount, requestedChain?: string) {
    const session = connector.getSession("solana");
    if (
      !session ||
      !accounts.some(
        (a) =>
          a.address === account.address &&
          hex.encode(new Uint8Array(a.publicKey)) ===
            hex.encode(new Uint8Array(account.publicKey)),
      )
    )
      throw new EWalletProviderError(
        4100,
        "This Solana account is not connected.",
      );
    if (requestedChain && requestedChain !== chain(session.networkId))
      throw new EWalletProviderError(
        4901,
        "Requested Solana chain differs from the connected chain.",
      );
    return session;
  }
  function one<T>(inputs: readonly T[]) {
    if (inputs.length !== 1)
      throw new EWalletProviderError(
        4200,
        "Review one transaction or message per user action.",
      );
    return inputs[0];
  }
  const wallet: WalletWithFeatures<Features> = {
    version: "1.0.0",
    name: "e-wallet Web",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTIiIGZpbGw9IiMyNjRlMzkiLz48dGV4dCB4PSIxNyIgeT0iNDYiIGZvbnQtc2l6ZT0iNDYiIGZpbGw9IndoaXRlIj5lPC90ZXh0Pjwvc3ZnPg==",
    chains: ["solana:localnet", "solana:devnet"],
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async (options) => {
          if (!options?.silent) await connector.connect("solana");
          update();
          return { accounts };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          await connector.disconnect("solana");
          update();
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event, listener) => {
          if (event !== "change")
            throw new EWalletProviderError(
              4200,
              "Unknown Wallet Standard event.",
            );
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs) => {
          const input = one(inputs);
          authorized(input.account);
          const result = z
            .object({ signature: z.string() })
            .parse(
              await connector.request("solana", "solana:signMessage", [
                {
                  account: input.account.address,
                  messageHex: "0x" + hex.encode(input.message),
                },
              ]),
            );
          return [
            {
              signedMessage: new Uint8Array(input.message),
              signature: hex.decode(result.signature.slice(2)),
            },
          ];
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs) => {
          const input = one(inputs),
            session = authorized(input.account, input.chain);
          if (input.options && Object.keys(input.options).length)
            throw new EWalletProviderError(
              4200,
              "Custom execution options are not supported.",
            );
          const result = z
            .object({ signedTransaction: z.string() })
            .parse(
              await connector.request("solana", "solana:signTransaction", [
                {
                  transaction: base64.encode(input.transaction),
                  account: input.account.address,
                  networkId: session.networkId,
                },
              ]),
            );
          return [
            { signedTransaction: base64.decode(result.signedTransaction) },
          ];
        },
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs) => {
          const input = one(inputs),
            session = authorized(input.account, input.chain);
          if (input.options && Object.keys(input.options).length)
            throw new EWalletProviderError(
              4200,
              "Custom execution options are not supported.",
            );
          const result = z
            .object({ hash: z.string() })
            .parse(
              await connector.request(
                "solana",
                "solana:signAndSendTransaction",
                [
                  {
                    transaction: base64.encode(input.transaction),
                    account: input.account.address,
                    networkId: session.networkId,
                  },
                ],
              ),
            );
          return [{ signature: base58.decode(result.hash) }];
        },
      },
    },
  };
  registerWallet(wallet);
  return {
    wallet,
    dispose() {
      off1();
      off2();
      listeners.clear();
      accounts = [];
    },
  };
}
