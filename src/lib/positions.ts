// Positions for Guard mode. Two sources, always labelled:
//   readAgentPositions  the agent wallet's real onchain holdings (proof of real execution)
//   projectPositions    what a simulated plan would hold now, re-priced at live prices (plus an optional scenario)
import { KNOWN_VAULTS, readUserPosition } from "@ixswap1/vault-agent-sdk";
import { formatUnits, parseAbi, type Address, type PublicClient } from "viem";
import { TOKENS, VENUES } from "./config";
import { erc20Abi, publicClient } from "./clients";
import { idleStablesUsd, scanWallet } from "./scan";
import type { Signals } from "./signals";
import type { Leg, Position } from "./types";

const vault4626 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/** idleUsd: the agent's idle stables right after deploy; null until the first Guard scan sets the baseline. */
const ixsRequestAbi = parseAbi([
  "function nextDepositRequestId() view returns (uint256)",
  "function pendingDepositRequest(uint256 requestId, address controller) view returns (uint256)",
]);

/**
 * The agent's pending IXS deposits, read from the vault itself. The SDK resolves request ids through a subgraph that
 * can lag (first live run: request #9 was on the vault but the SDK saw nothing). Request ids are sequential, so the
 * last `lookback` ids cover any deposit still waiting for its T+1 settlement.
 */
async function ixsPendingFromVault(c: PublicClient, vault: Address, agent: Address, lookback = 25): Promise<bigint | null> {
  try {
    const last = await c.readContract({ address: vault, abi: ixsRequestAbi, functionName: "nextDepositRequestId" });
    const ids: bigint[] = [];
    for (let id = last; id >= 1n && ids.length < lookback; id--) ids.push(id);
    const res = await c.multicall({
      contracts: ids.map((id) => ({ address: vault, abi: ixsRequestAbi, functionName: "pendingDepositRequest" as const, args: [id, agent] as const })),
      allowFailure: true,
    });
    return res.reduce((a, r) => a + (r.status === "success" ? (r.result as bigint) : 0n), 0n);
  } catch {
    return null;
  }
}

export type Entry = { at: number; ethPriceUsd: number | null; idleUsd: number | null };
export type Scenario = { ethMult: number } | null;

const round = (n: number) => Math.round(n * 100) / 100;
/** "+1.2%" / "-3.4%", and "+0.0%" rather than "-0.0%" for tiny moves. */
const signedPct = (p: number) => { const r = Math.round(p * 10) / 10; return `${r >= 0 ? "+" : ""}${(r === 0 ? 0 : r).toFixed(1)}%`; };

/** The agent wallet's real positions, read onchain. */
export async function readAgentPositions(agent: Address, s: Signals, scenario: Scenario = null): Promise<{ positions: Position[]; idleUsd: number }> {
  const avax = publicClient("avalanche");
  const baseC = publicClient("base");
  const rh = publicClient("robinhood");
  const ixsVault = KNOWN_VAULTS["avax-ixhyb"];

  const [ixsPos, ixsVaultPending, morphoShares, weth, scan] = await Promise.all([
    readUserPosition(avax as unknown as Parameters<typeof readUserPosition>[0], ixsVault, agent, TOKENS.avalanche.USDC).catch(() => null),
    ixsPendingFromVault(avax as PublicClient, ixsVault.address as Address, agent),
    baseC.readContract({ address: VENUES.base.address!, abi: vault4626, functionName: "balanceOf", args: [agent] }).catch(() => 0n),
    rh.readContract({ address: TOKENS.robinhood.WETH, abi: erc20Abi, functionName: "balanceOf", args: [agent] }).catch(() => 0n),
    scanWallet(agent),
  ]);

  // IXS: settled shares valued at the vault's rate, plus any deposit still pending settlement (T+1).
  let ixsShares = 0;
  if (ixsPos?.shareBalance && ixsPos.shareBalance > 0n) {
    const assets = await (avax as PublicClient).readContract({ address: ixsVault.address, abi: vault4626, functionName: "convertToAssets", args: [ixsPos.shareBalance] });
    ixsShares = Number(formatUnits(assets, 6));
  }
  // The vault's own record wins; the SDK's figure is the fallback if the vault read failed.
  const pendingRaw = ixsVaultPending ?? ixsPos?.pendingDeposit ?? 0n;
  const ixsPending = Number(formatUnits(pendingRaw, 6));
  const ixsUsd = ixsShares + ixsPending;

  // Base: Morpho ERC-4626 shares to assets.
  let baseUsd = 0;
  if (morphoShares > 0n) {
    const assets = await baseC.readContract({ address: VENUES.base.address!, abi: vault4626, functionName: "convertToAssets", args: [morphoShares] });
    baseUsd = Number(formatUnits(assets, 6));
  }

  // ETH: WETH at the pool price (scenario re-prices it for what-if reasoning only).
  const price = (s.rhEth.priceUsd ?? 0) * (scenario?.ethMult ?? 1);
  const ethUsd = Number(formatUnits(weth, 18)) * price;

  const positions: Position[] = [
    {
      venue: "ixs", usd: round(ixsUsd),
      status: ixsPending > 0 ? "PENDING_T1" : ixsShares > 0 ? "SETTLED" : "EMPTY",
      detail: ixsPending > 0 ? `$${round(ixsPending)} settling T+1${ixsShares > 0 ? `, $${round(ixsShares)} in shares` : ""}` : ixsShares > 0 ? "Shares received" : "No position",
    },
    { venue: "base", usd: round(baseUsd), status: baseUsd > 0 ? "EARNING" : "EMPTY", detail: baseUsd > 0 ? `Earning ${s.base.netApyPct ?? "?"}%, withdraw instantly` : "No position" },
    { venue: "rh_eth", usd: round(ethUsd), status: ethUsd > 0 ? "HELD" : "EMPTY", detail: ethUsd > 0 ? `${Number(formatUnits(weth, 18)).toFixed(6)} WETH at $${price.toFixed(2)}` : "No position" },
  ];
  return { positions, idleUsd: idleStablesUsd(scan.holdings) };
}

/** A simulated plan's positions now: IXS settles after a day, Base accrues, ETH moves with the pool price. */
export function projectPositions(legs: Leg[], entry: Entry, s: Signals, scenario: Scenario = null, now = Date.now()): Position[] {
  const days = Math.max(0, (now - entry.at) / 86_400_000);
  const priceNow = (s.rhEth.priceUsd ?? entry.ethPriceUsd ?? 0) * (scenario?.ethMult ?? 1);
  const leg = (v: Leg["venue"]) => legs.find((l) => l.venue === v)?.usd ?? 0;

  const ixs = leg("ixs");
  const base = leg("base") * (1 + ((s.base.netApyPct ?? 0) / 100) * (days / 365));
  const ethMove = entry.ethPriceUsd && priceNow ? priceNow / entry.ethPriceUsd : 1;
  const eth = leg("rh_eth") * ethMove;

  return [
    { venue: "ixs", usd: round(ixs), status: ixs === 0 ? "EMPTY" : days >= 1 ? "SETTLED" : "PENDING_T1", detail: ixs === 0 ? "Not in plan" : days >= 1 ? "Projected: shares received" : "Projected: settling T+1" },
    { venue: "base", usd: round(base), status: base === 0 ? "EMPTY" : "EARNING", detail: base === 0 ? "Not in plan" : `Projected: earning ${s.base.netApyPct ?? "?"}%` },
    {
      venue: "rh_eth", usd: round(eth), status: eth === 0 ? "EMPTY" : "HELD",
      detail: eth === 0 ? "Not in plan" : `Projected: ETH ${signedPct((ethMove - 1) * 100)} since entry`,
    },
  ];
}
