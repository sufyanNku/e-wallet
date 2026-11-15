import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { WalletProvider } from "./context";
import type { WalletGateway } from "@ewallet/domain";
import "./styles.css";
async function start() {
  let gateway: WalletGateway;
  if (__WALLET_MODE__ === "mock") {
    const { MockWalletGateway } = await import("./mock-gateway");
    gateway = new MockWalletGateway();
  } else {
    const { RealWalletGateway } = await import("./real-gateway");
    gateway = await RealWalletGateway.open();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: 1, refetchOnWindowFocus: false },
            },
          })
        }
      >
        <WalletProvider gateway={gateway}>
          <App />
        </WalletProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
void start().catch(() => {
  document.getElementById("root")!.textContent =
    "Wallet unavailable. This build cannot connect to the required signing core. No mock fallback was used.";
});
