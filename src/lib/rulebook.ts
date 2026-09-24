// Hard rules live in code (SERV "day one": exact business rules are not the model's job).
// SERV reasons about weights inside these bounds; plan-guard re-checks them before any money moves.
import { GAS_MIN, STOCK_TOKEN_EXCLUDED, VENUES, VENUE_IDS, type ChainKey, type VenueId } from "./config";
import type { Eligibility, Position, Preference, Profile, ReasonCode, Risk, Split, Trigger } from "./types";

export type RuleInputs = {
  ixs: { paused: boolean; whitelistEnabled: boolean; agentWhitelisted: boolean };
  usMarketOpen: boolean;
  /** Idle stablecoins the executing wallet holds per chain (USD). Omitted = not constrained (demo planning). */
  chainFunds?: Partial<Record<ChainKey, number>>;
  /** Native gas the executing wallet holds per chain. Omitted = not checked. */
  chainGas?: Partial<Record<ChainKey, number>>;
};

const VOLATILE_CAP: Record<Preference, Record<Risk, number>> = {
  stable: { low: 0, medium: 0, high: 0 },
  mixed: { low: 10, medium: 20, high: 30 },
  volatile: { low: 15, medium: 35, high: 60 },
};

/** Every plan keeps at least this share in Base USDC lending (instant withdrawal) as a liquidity buffer. */
export const LIQUIDITY_BUFFER_PCT = 20;

export function volatileCap(p: Pick<Profile, "preference" | "risk">): number {
  return VOLATILE_CAP[p.preference][p.risk];
}

export function eligibility(profile: Profile, inputs: RuleInputs): Record<VenueId, Eligibility> {
  const cap = volatileCap(profile);
  const out = {} as Record<VenueId, Eligibility>;
  for (const id of VENUE_IDS) out[id] = { venue: id, allowed: true, reasons: [], maxPct: 100 };

  const block = (id: VenueId, reason: ReasonCode) => {
    out[id].allowed = false;
    out[id].maxPct = 0;
    if (!out[id].reasons.includes(reason)) out[id].reasons.push(reason);
  };

  // IXS: async ERC-7540 (T+1, T+2 over weekends), 50bps exit, $100 minimum, optional whitelist.
  if (profile.instantAccess || profile.horizon === "under_1m") block("ixs", "SETTLEMENT_TOO_SLOW");
  if (profile.amountUsd < VENUES.ixs.minUsd) block("ixs", "BELOW_MINIMUM");
  if (inputs.ixs.paused) block("ixs", "VAULT_PAUSED");
  if (inputs.ixs.whitelistEnabled && !inputs.ixs.agentWhitelisted) block("ixs", "VAULT_WHITELIST");

  // Base USDC lending: instant, no minimum that matters. Always allowed.
  out.base.reasons.push("INSTANT_LIQUIDITY");

  // Stock Tokens: geofenced, and not executed in v1.
  if ((STOCK_TOKEN_EXCLUDED as readonly string[]).includes(profile.residence)) block("rh_stocks", "JURISDICTION");
  else block("rh_stocks", "NOT_EXECUTABLE_V1");
  if (!inputs.usMarketOpen) out.rh_stocks.reasons.push("MARKET_CLOSED");

  // Volatile legs share one cap set by risk x preference.
  if (cap === 0) {
    block("rh_eth", profile.preference === "stable" ? "STABLE_ONLY" : "RISK_CAP");
  } else {
    out.rh_eth.maxPct = cap;
    out.rh_eth.reasons.push("VOLATILE_OPT_IN");
    if (out.rh_stocks.allowed) out.rh_stocks.maxPct = cap;
  }

  // Funds live on specific chains and v1 does not bridge: a venue can only take what its chain holds.
  if (inputs.chainFunds && profile.amountUsd > 0) {
    for (const id of VENUE_IDS) {
      if (!out[id].allowed || id === "rh_stocks") continue;
      const funds = inputs.chainFunds[VENUES[id].chain] ?? 0;
      if (funds < VENUES[id].minUsd) { block(id, "NO_FUNDS_ON_CHAIN"); continue; }
      if (inputs.chainGas && (inputs.chainGas[VENUES[id].chain] ?? 0) < GAS_MIN[VENUES[id].chain]) { block(id, "NO_GAS_ON_CHAIN"); continue; }
      out[id].maxPct = Math.min(out[id].maxPct, Math.floor((funds / profile.amountUsd) * 100));
      if (out[id].maxPct < 100) out[id].reasons.push("NO_FUNDS_ON_CHAIN");
    }
  }
  return out;
}

export const DRIFT_PP = 5;
export const NEW_CASH_USD = 20;
export const YIELD_GAP_PP = 1;

/**
 * Guard triggers. Pure code: the model never decides whether something fired.
 * positions: current value per venue; targets: the plan's split; idle*: idle stables now / at deploy.
 */
export function triggers(input: {
  positions: Position[];
  targets: Split;
  profile: Pick<Profile, "preference" | "risk">;
  baseApyPct: number | null;
  ixsYieldPct: number;
  ixs: { paused: boolean; whitelistEnabled: boolean; agentWhitelisted: boolean; navFresh: boolean | null };
  idleNowUsd: number;
  idleAtDeployUsd: number;
}): Trigger[] {
  const out: Trigger[] = [];
  const held = input.positions.filter((p) => p.usd > 0);
  const total = held.reduce((a, p) => a + p.usd, 0);
  if (total > 0) {
    for (const p of input.positions) {
      const w = (p.usd / total) * 100;
      const t = input.targets[p.venue] ?? 0;
      if (Math.abs(w - t) > DRIFT_PP) {
        out.push({ code: "DRIFT", venue: p.venue, detail: `${VENUES[p.venue].hud} ${w.toFixed(1)}% vs target ${t}%` });
      }
    }
    const cap = volatileCap(input.profile);
    const vol = input.positions.filter((p) => VENUES[p.venue].kind === "volatile").reduce((a, p) => a + p.usd, 0);
    const volPct = (vol / total) * 100;
    if (volPct > cap + 0.5) out.push({ code: "DRIFT", detail: `Volatile share ${volPct.toFixed(1)}% over the ${cap}% cap` });
  }
  const holdsIxs = input.positions.some((p) => p.venue === "ixs" && p.usd > 0);
  if (holdsIxs && input.baseApyPct != null && input.ixsYieldPct - input.baseApyPct < YIELD_GAP_PP) {
    out.push({ code: "YIELD_GAP", venue: "ixs", detail: `IXS ${input.ixsYieldPct}% vs Base ${input.baseApyPct}%: gap under ${YIELD_GAP_PP}pp` });
  }
  if (holdsIxs) {
    if (input.ixs.paused) out.push({ code: "VAULT_RULE", venue: "ixs", detail: "IXS vault paused" });
    if (input.ixs.whitelistEnabled && !input.ixs.agentWhitelisted) out.push({ code: "VAULT_RULE", venue: "ixs", detail: "IXS whitelist switched on" });
    if (input.ixs.navFresh === false) out.push({ code: "VAULT_RULE", venue: "ixs", detail: "IXS NAV is stale" });
  }
  const fresh = input.idleNowUsd - input.idleAtDeployUsd;
  if (fresh >= NEW_CASH_USD) out.push({ code: "NEW_CASH", detail: `$${fresh.toFixed(2)} new idle stables since deploy` });
  return out;
}

export function minPctFor(id: VenueId, amountUsd: number): number {
  return amountUsd > 0 ? Math.ceil((VENUES[id].minUsd / amountUsd) * 100) : 100;
}
