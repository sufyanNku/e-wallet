import { WalletErrorBoundary } from "./error-boundary";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { WalletProvider } from "./context";
import type { WalletGateway } from "@ewallet/domain";
import { RealWalletGateway } from "./real-gateway";
import "@fontsource-variable/manrope";
import "./styles.css";
import "./product.css";
async function start() {
  const gateway: WalletGateway = await RealWalletGateway.open();
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
          <WalletErrorBoundary lock={() => gateway.lock()}>
            <App />
          </WalletErrorBoundary>
        </WalletProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
void start().catch(() => {
  const root = document.getElementById("root")!;
  const main = document.createElement("main");
  main.className = "onboarding";
  const title = document.createElement("h1");
  title.textContent = "Let’s reconnect.";
  const body = document.createElement("p");
  body.className = "intro";
  body.textContent =
    "The signing core could not start. Reload to try again. Your encrypted wallet has not been replaced.";
  const button = document.createElement("button");
  button.className = "button primary";
  button.textContent = "Reload wallet";
  button.addEventListener("click", () => window.location.reload());
  main.append(title, body, button);
  root.replaceChildren(main);
});
