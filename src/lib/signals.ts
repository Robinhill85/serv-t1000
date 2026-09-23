// Market signals: deterministic reads of live data. No model involved here.
import type { Address } from "viem";
import { IXS_EST_YIELD, TOKENS, UNISWAP_RH, VENUES } from "./config";
import { erc20Abi, publicClient } from "./clients";

export type SignalStatus = "LIVE" | "UNAVAILABLE";

export type Signals = {
  at: string;
  market: { usMarketOpen: boolean; session: string; weekend: boolean };
  base: { status: SignalStatus; netApyPct: number | null; tvlUsd: number | null };
  ixs: {
    status: SignalStatus;
    estYieldPct: number;
    estYieldAsOf: string;
    minUsd: number;
    exitFeeBps: number | null;
    paused: boolean;
    whitelistEnabled: boolean;
    agentWhitelisted: boolean;
    navFresh: boolean | null;
    pricePerShare: number | null;
    settlement: string;
  };
  rhEth: { status: SignalStatus; priceUsd: number | null; poolUsdgDepth: number | null; change7dPct: number | null };
  stocks: { oracleState: string };
};

/** US equity session in New York time. Holidays are not modelled; weekends are. */
export function usSession(now = new Date()): Signals["market"] {
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = ny.getDay();
  const mins = ny.getHours() * 60 + ny.getMinutes();
  const weekend = day === 0 || day === 6;
  if (weekend) return { usMarketOpen: false, session: "weekend: stock oracles frozen since Friday close", weekend };
  if (mins >= 570 && mins < 960) return { usMarketOpen: true, session: "regular session", weekend };
  if (mins >= 240 && mins < 570) return { usMarketOpen: false, session: "pre-market", weekend };
  if (mins >= 960 && mins < 1200) return { usMarketOpen: false, session: "after hours", weekend };
  return { usMarketOpen: false, session: "overnight", weekend };
}

async function morpho(): Promise<Signals["base"]> {
  try {
    const res = await fetch("https://api.morpho.org/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{ vaultByAddress(address: "${VENUES.base.address}", chainId: 8453) { state { netApy totalAssetsUsd } } }`,
      }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    const json = await res.json();
    const s = json?.data?.vaultByAddress?.state;
    if (!s) throw new Error("no state");
    return { status: "LIVE", netApyPct: Math.round(s.netApy * 10000) / 100, tvlUsd: Math.round(s.totalAssetsUsd) };
  } catch {
    return { status: "UNAVAILABLE", netApyPct: null, tvlUsd: null };
  }
}

const ixsAbi = [
  { type: "function", name: "whitelistEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "whitelist", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "minDepositAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "redeemFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isNavFresh", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "pricePerShare", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function ixs(agent?: Address): Promise<Signals["ixs"]> {
  const base = {
    estYieldPct: IXS_EST_YIELD.pct,
    estYieldAsOf: IXS_EST_YIELD.asOf,
    settlement: "async ERC-7540: T+1, T+2 over weekends",
  };
  try {
    const c = publicClient("avalanche");
    const address = VENUES.ixs.address!;
    const read = <T,>(functionName: (typeof ixsAbi)[number]["name"], args: readonly unknown[] = []) =>
      c.readContract({ address, abi: ixsAbi, functionName, args } as never) as Promise<T>;
    const [wl, paused, min, fee, fresh, pps] = await Promise.all([
      read<boolean>("whitelistEnabled"),
      read<boolean>("paused"),
      read<bigint>("minDepositAssets"),
      read<bigint>("redeemFeeBps"),
      read<boolean>("isNavFresh"),
      read<bigint>("pricePerShare"),
    ]);
    const agentWhitelisted = wl && agent ? await read<boolean>("whitelist", [agent]) : false;
    return {
      ...base,
      status: "LIVE",
      minUsd: Number(min) / 1e6,
      exitFeeBps: Number(fee),
      paused,
      whitelistEnabled: wl,
      agentWhitelisted,
      navFresh: fresh,
      pricePerShare: Number(pps) / 1e6,
    };
  } catch {
    // Fail closed: an unreadable vault is treated as paused so the rulebook blocks it.
    return { ...base, status: "UNAVAILABLE", minUsd: VENUES.ixs.minUsd, exitFeeBps: null, paused: true, whitelistEnabled: false, agentWhitelisted: false, navFresh: null, pricePerShare: null };
  }
}

const slot0Abi = [
  {
    type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }],
  },
] as const;

async function rhEth(): Promise<Signals["rhEth"]> {
  try {
    const c = publicClient("robinhood");
    const [slot0, depth] = await Promise.all([
      c.readContract({ address: UNISWAP_RH.wethUsdgPool, abi: slot0Abi, functionName: "slot0" }),
      c.readContract({ address: TOKENS.robinhood.USDG, abi: erc20Abi, functionName: "balanceOf", args: [UNISWAP_RH.wethUsdgPool] }),
    ]);
    // token0 = WETH (18 dp), token1 = USDG (6 dp): price = (sqrtP / 2^96)^2 * 10^(18-6)
    const sqrt = Number(slot0[0]) / 2 ** 96;
    const priceUsd = Math.round(sqrt * sqrt * 1e12 * 100) / 100;
    let change7dPct: number | null = null;
    try {
      const r = await fetch("https://coins.llama.fi/percentage/coingecko:ethereum?period=7d", { signal: AbortSignal.timeout(5_000), cache: "no-store" });
      change7dPct = Math.round((await r.json()).coins["coingecko:ethereum"] * 100) / 100;
    } catch { /* optional */ }
    return { status: "LIVE", priceUsd, poolUsdgDepth: Math.round(Number(depth) / 1e6), change7dPct };
  } catch {
    return { status: "UNAVAILABLE", priceUsd: null, poolUsdgDepth: null, change7dPct: null };
  }
}

export async function getSignals(agent?: Address, now = new Date()): Promise<Signals> {
  const market = usSession(now);
  const [b, i, r] = await Promise.all([morpho(), ixs(agent), rhEth()]);
  return {
    at: now.toISOString(),
    market,
    base: b,
    ixs: i,
    rhEth: r,
    stocks: {
      oracleState: market.weekend
        ? "Chainlink equity feeds frozen (weekend); issuer weekend quotes run 5-20% wide"
        : market.usMarketOpen ? "feeds live" : "feeds live (24/5 extended session)",
    },
  };
}
