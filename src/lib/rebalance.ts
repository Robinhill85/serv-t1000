// Guard mode: when a trigger fires, SERV proposes the fewest moves that restore the plan's intent.
// v1 moves money within one chain only (a venue <-> that chain's idle stables); anything that would need a bridge
// is proposed with bridge_required and never executed.
import { z } from "zod";
import { VENUES, VENUE_IDS, type ChainKey } from "./config";
import { servJson, type DecideMode, type ServResult } from "./decide";
import { LIQUIDITY_BUFFER_PCT, volatileCap } from "./rulebook";
import type { Signals } from "./signals";
import type { Position, Profile, Split, Trigger } from "./types";

export const MOVE_ENDS = [...VENUE_IDS, "idle"] as const;
export type MoveEnd = (typeof MOVE_ENDS)[number];
export type Move = { from: MoveEnd; to: MoveEnd; usd: number; bridge_required: boolean; why: string };
export type RebalanceDecision = { moves: Move[]; summary: string };

// SERV's Prompt Guard screens the verified call. A wording that talks about how the input was "computed in code" or
// shouts (ABOVE) got every verify refused ("I can't share that."); this version passed 6/6. Re-test after edits.
export const REBALANCE_PROMPT = `You are T1000 in Guard mode. The user's capital is already deployed. One or more guard triggers fired. Propose the fewest moves that restore the intent of the user's plan, or no moves if acting would cost more than it saves.

Venues: ixs = licensed RWA bond vault on Avalanche (exits settle T+1 with a 0.5% fee, deposits minimum $100); base = USDC lending on Base (instant in and out); rh_eth = ETH on Robinhood Chain (volatile). "idle" = the stablecoins the agent holds on that venue's chain.

Non-negotiable constraints:
- The agent cannot bridge between chains in this version. A move is executable only when one side is "idle" and the other is a venue (the idle side is on that venue's chain). Any other move must set bridge_required true.
- A move out of a venue cannot exceed that position's value. A move from idle into a venue cannot exceed the idle funds on that venue's chain.
- Deposits into ixs are at least $100. Ignore moves under $5.
- After the moves, the volatile share must be within the volatile cap.

Each position lists weight_pct, target_pct and drift_pp (weight minus target; positive means above target).

Policy:
- DRIFT on a volatile leg above its target (drift_pp > 0): trim it by its trim_to_target_usd, moving the excess to idle on its chain.
- DRIFT on a stable leg: prefer holding unless the gap is large; stable legs drift only through other legs moving.
- YIELD_GAP: leaving ixs costs 0.5% and a day. Only exit ixs when the yield gap is clearly negative and the horizon allows; moving the proceeds to base needs a bridge, so propose it with bridge_required true and explain.
- VAULT_RULE: if the ixs vault is paused or whitelisted, the agent may be unable to exit; propose holding and explain what the agent will watch.
- NEW_CASH is handled by feeding, not by rebalancing; ignore it here.

The summary is two plain sentences for the user, naming venues in plain words (the IXS vault, Base USDC lending, ETH on Robinhood Chain). Each move's why is one short sentence with a number.`;

const endEnum = z.enum(MOVE_ENDS as unknown as [MoveEnd, ...MoveEnd[]]);
export const RebalanceSchema = z.object({
  moves: z.array(z.object({ from: endEnum, to: endEnum, usd: z.number(), bridge_required: z.boolean(), why: z.string() })),
  summary: z.string(),
});

const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["moves", "summary"],
  properties: {
    moves: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "usd", "bridge_required", "why"],
        properties: {
          from: { type: "string", enum: [...MOVE_ENDS] },
          to: { type: "string", enum: [...MOVE_ENDS] },
          usd: { type: "number" },
          bridge_required: { type: "boolean" },
          why: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
};

const SHADOW_HINT =
  "Every move with bridge_required=false has exactly one side 'idle'; no move exceeds the position or the idle funds on that chain; ixs deposits are at least $100; the resulting volatile share is within volatile_cap_pct.";

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The amount to move from a position to idle so its weight lands on the target. Moving x out of the held total:
 * (usd - x) / (total - x) = t  =>  x = (usd - t*total) / (1 - t). Zero when the position is at or below target.
 */
export function trimToTarget(usd: number, total: number, targetPct: number): number {
  const t = targetPct / 100;
  if (total <= 0 || t >= 1) return 0;
  const x = (usd - t * total) / (1 - t);
  return x > 0 ? Math.round(x * 100) / 100 : 0;
}

export function rebalanceInput(args: {
  profile: Pick<Profile, "preference" | "risk" | "horizon" | "instantAccess">;
  targets: Split;
  positions: Position[];
  triggers: Trigger[];
  signals: Signals;
  idleByChain: Partial<Record<ChainKey, number>>;
  scenario: { ethMult: number } | null;
}) {
  const total = args.positions.reduce((a, p) => a + p.usd, 0);
  return {
    profile: args.profile,
    volatile_cap_pct: volatileCap(args.profile),
    liquidity_buffer_pct: LIQUIDITY_BUFFER_PCT,
    targets_pct: args.targets,
    positions: args.positions.map((p) => {
      const weight = total > 0 ? (p.usd / total) * 100 : 0;
      const target = args.targets[p.venue] ?? 0;
      return {
        venue: p.venue, chain: VENUES[p.venue].chain, usd: p.usd, weight_pct: round1(weight), target_pct: target,
        drift_pp: round1(weight - target), trim_to_target_usd: trimToTarget(p.usd, total, target), status: p.status,
      };
    }),
    triggers: args.triggers,
    idle_by_chain_usd: args.idleByChain,
    signals: {
      base_net_apy_pct: args.signals.base.netApyPct,
      ixs_est_yield_pct: args.signals.ixs.estYieldPct,
      ixs_exit: "T+1, 0.5% fee",
      eth_price_usd: args.signals.rhEth.priceUsd,
      market: args.signals.market.session,
    },
    scenario: args.scenario ? `WHAT-IF: ETH priced at ${args.scenario.ethMult}x the live price` : null,
  };
}

export function decideRebalance(input: ReturnType<typeof rebalanceInput>, mode: DecideMode, draft?: RebalanceDecision): Promise<ServResult<RebalanceDecision>> {
  return servJson<RebalanceDecision>({
    system: REBALANCE_PROMPT, input, schemaName: "t1000_rebalance", schema: JSON_SCHEMA,
    parse: RebalanceSchema as unknown as z.ZodType<RebalanceDecision>, shadowHint: SHADOW_HINT, mode, draft,
  });
}

/** The chain a move happens on, or null when it would need a bridge. */
export function moveChain(m: Pick<Move, "from" | "to">): ChainKey | null {
  if (m.from === "idle" && m.to !== "idle") return VENUES[m.to].chain;
  if (m.to === "idle" && m.from !== "idle") return VENUES[m.from].chain;
  return null;
}
