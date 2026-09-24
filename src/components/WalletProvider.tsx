"use client";
// "My wallet" mode: the user's own browser wallet on Base, Avalanche and Robinhood Chain. Browser-extension wallets
// (MetaMask, Rabby, Brave...) through the injected connector, plus the Coinbase Wallet extension/app as a plain EOA
// (the Smart Wallet does not run on Avalanche or Robinhood Chain). No WalletConnect: it needs a Reown project id.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { avalanche, base } from "viem/chains";
import { createConfig, http, WagmiProvider } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { robinhood } from "@/lib/config";

export const wagmiConfig = createConfig({
  chains: [base, avalanche, robinhood],
  connectors: [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ version: "4", appName: "T1000", preference: "eoaOnly" }),
  ],
  // Public RPCs only: receipts and allowance checks from the browser. Robinhood Chain's public RPC serves eth_call.
  transports: {
    [base.id]: http("https://base-rpc.publicnode.com"),
    [avalanche.id]: http("https://api.avax.network/ext/bc/C/rpc"),
    [robinhood.id]: http("https://rpc.mainnet.chain.robinhood.com"),
  },
  ssr: true,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
