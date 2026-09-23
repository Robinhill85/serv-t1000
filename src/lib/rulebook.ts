// Hard rules live in code (SERV "day one": exact business rules are not the model's job).
// SERV reasons about weights inside these bounds; plan-guard re-checks them before any money moves.
import { STOCK_TOKEN_EXCLUDED, VENUES, VENUE_IDS, type VenueId } from "./config";
import type { Eligibility, Preference, Profile, ReasonCode, Risk } from "./types";

export type RuleInputs = {
  ixs: { paused: boolean; whitelistEnabled: boolean; agentWhitelisted: boolean };
  usMarketOpen: boolean;
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
  return out;
}

export function minPctFor(id: VenueId, amountUsd: number): number {
  return amountUsd > 0 ? Math.ceil((VENUES[id].minUsd / amountUsd) * 100) : 100;
}
