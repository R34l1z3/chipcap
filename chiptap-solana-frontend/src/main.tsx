// ============================================================
// src/main.tsx — wallet-adapter + react-query provider chain
// ============================================================

import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ConnectionProvider as _ConnectionProvider,
  WalletProvider     as _WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider as _WalletModalProvider } from "@solana/wallet-adapter-react-ui";

// wallet-adapter ships React types from before ReactNode widened to include
// `bigint | Promise<ReactNode>` (React 19+).  Cast through `any` to satisfy
// the JSX checker without altering runtime behaviour.
const ConnectionProvider  = _ConnectionProvider  as unknown as React.FC<any>;
const WalletProvider      = _WalletProvider      as unknown as React.FC<any>;
const WalletModalProvider = _WalletModalProvider as unknown as React.FC<any>;
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";

import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { CLUSTER, RPC_URL } from "./config";
import "./i18n";          // initialise react-i18next before first render
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

function Root() {
  // Wallet adapters: Phantom + Solflare cover ~95% of installs.
  // Backpack et al support the Wallet Standard and auto-detect via the
  // adapter base — no explicit registration needed.
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  // Hint to the wallet UI which network we're on.
  const endpoint =
    RPC_URL ||
    (CLUSTER === "mainnet" ? clusterApiUrl("mainnet-beta")
     : CLUSTER === "devnet" ? clusterApiUrl("devnet")
     : "http://127.0.0.1:8899");

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
);
