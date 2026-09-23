import { defineChain, type Address, type Chain } from "viem";
import { avalanche, base } from "viem/chains";

// Robinhood Chain (Arbitrum Orbit L2). Public RPC answers eth_chainId but 403s eth_call, so reads go through Alchemy.
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export type ChainKey = "base" | "avalanche" | "robinhood";

// publicRpc = fallback when Alchemy fails or the network is not enabled on the Alchemy app.
// Robinhood Chain has none: its public RPC returns 403 on eth_call.
export const CHAINS: Record<ChainKey, { chain: Chain; alchemy: string; publicRpc?: string; explorer: string }> = {
  base: { chain: base, alchemy: "base-mainnet", publicRpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
  avalanche: { chain: avalanche, alchemy: "avax-mainnet", publicRpc: "https://api.avax.network/ext/bc/C/rpc", explorer: "https://snowtrace.io" },
  robinhood: { chain: robinhood, alchemy: "robinhood-mainnet", explorer: "https://robinhoodchain.blockscout.com" },
};

export function rpcUrl(key: ChainKey): string {
  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) throw new Error("ALCHEMY_API_KEY is not set");
  return `https://${CHAINS[key].alchemy}.g.alchemy.com/v2/${apiKey}`;
}

export const TOKENS = {
  base: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address },
  avalanche: { USDC: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" as Address },
  robinhood: {
    USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
    WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  },
} as const;

// Uniswap v3 on Robinhood Chain (developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments)
export const UNISWAP_RH = {
  factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as Address,
  quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as Address,
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2" as Address,
  // WETH/USDG 0.01% pool: deepest (~$13M USDG, verified 2026-09-22)
  wethUsdgPool: "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca" as Address,
  wethUsdgFee: 100,
};

export type VenueId = "ixs" | "base" | "rh_eth" | "rh_stocks";

export type Venue = {
  id: VenueId;
  hud: string; // short uppercase label for the HUD
  name: string;
  chain: ChainKey;
  kind: "stable_yield" | "rwa_yield" | "volatile";
  minUsd: number;
  executable: boolean; // v1 execution support
  address?: Address;
};

export const VENUES: Record<VenueId, Venue> = {
  ixs: {
    id: "ixs",
    hud: "IXS RWA VAULT",
    name: "IXS High Yield Corporate Bond Vault (IXHYB)",
    chain: "avalanche",
    kind: "rwa_yield",
    minUsd: 100,
    executable: true,
    address: "0xaD01573b459805E3954398796203d830B57A8bD9",
  },
  base: {
    id: "base",
    hud: "BASE USDC LENDING",
    name: "Gauntlet USDC Prime (Morpho, Base)",
    chain: "base",
    kind: "stable_yield",
    minUsd: 1,
    executable: true,
    address: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
  },
  rh_eth: {
    id: "rh_eth",
    hud: "ROBINHOOD CHAIN ETH",
    name: "WETH on Robinhood Chain (Uniswap v3)",
    chain: "robinhood",
    kind: "volatile",
    minUsd: 5,
    executable: true,
    address: TOKENS.robinhood.WETH,
  },
  rh_stocks: {
    id: "rh_stocks",
    hud: "ROBINHOOD STOCK TOKENS",
    name: "Robinhood Stock Tokens (Robinhood Chain)",
    chain: "robinhood",
    kind: "volatile",
    minUsd: 5,
    executable: false,
  },
};

export const VENUE_IDS = Object.keys(VENUES) as VenueId[];

// IXS estimated yield: vaults.ixs.finance, verified 2026-09-07 (registry: vaultterms/registry/vaults.json)
export const IXS_EST_YIELD = { pct: 6.0, asOf: "2026-09-07", source: "vaults.ixs.finance" };

// Residents excluded from Robinhood Stock Tokens (geofence in Robinhood's app; contracts are permissionless).
export const STOCK_TOKEN_EXCLUDED = ["US", "UK", "CA", "CH"] as const;

export function executionLimits() {
  return {
    enabled: process.env.EXECUTION_ENABLED === "true",
    maxRunUsd: Number(process.env.MAX_RUN_USD ?? 150),
  };
}
