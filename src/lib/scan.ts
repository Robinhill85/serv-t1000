// Wallet scan: what the connected wallet holds on the three chains the agent can reach.
import { formatUnits, type Address } from "viem";
import { TOKENS, type ChainKey } from "./config";
import { erc20Abi, publicClient } from "./clients";

export type Holding = { chain: ChainKey; symbol: string; amount: number; stable: boolean };

const ERC20S: { chain: ChainKey; symbol: string; address: Address; decimals: number; stable: boolean }[] = [
  { chain: "base", symbol: "USDC", address: TOKENS.base.USDC, decimals: 6, stable: true },
  { chain: "avalanche", symbol: "USDC", address: TOKENS.avalanche.USDC, decimals: 6, stable: true },
  { chain: "robinhood", symbol: "USDG", address: TOKENS.robinhood.USDG, decimals: 6, stable: true },
  { chain: "robinhood", symbol: "WETH", address: TOKENS.robinhood.WETH, decimals: 18, stable: false },
];
const NATIVE: { chain: ChainKey; symbol: string }[] = [
  { chain: "base", symbol: "ETH" },
  { chain: "avalanche", symbol: "AVAX" },
  { chain: "robinhood", symbol: "ETH" },
];

export async function scanWallet(owner: Address): Promise<{ holdings: Holding[]; errors: string[] }> {
  const errors: string[] = [];
  const tokenReads = ERC20S.map(async (t) => {
    const raw = await publicClient(t.chain).readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    return { chain: t.chain, symbol: t.symbol, amount: Number(formatUnits(raw, t.decimals)), stable: t.stable };
  });
  const nativeReads = NATIVE.map(async (n) => {
    const raw = await publicClient(n.chain).getBalance({ address: owner });
    return { chain: n.chain, symbol: n.symbol, amount: Number(formatUnits(raw, 18)), stable: false };
  });
  const settled = await Promise.allSettled([...tokenReads, ...nativeReads]);
  const holdings: Holding[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") holdings.push(r.value);
    else {
      const src = i < ERC20S.length ? ERC20S[i] : NATIVE[i - ERC20S.length];
      errors.push(`${src.chain} ${src.symbol}: unavailable`);
    }
  });
  return { holdings, errors };
}

export function idleStablesUsd(holdings: Holding[]): number {
  return Math.round(holdings.filter((h) => h.stable).reduce((a, h) => a + h.amount, 0) * 100) / 100;
}
