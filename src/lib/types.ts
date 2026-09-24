import type { VenueId } from "./config";

export type Residence = "UK" | "EU" | "US" | "OTHER";
export type Horizon = "under_1m" | "1_3m" | "3_12m" | "over_1y";
export type Risk = "low" | "medium" | "high";
export type Preference = "stable" | "mixed" | "volatile";

export type Profile = {
  residence: Residence;
  amountUsd: number;
  horizon: Horizon;
  risk: Risk;
  instantAccess: boolean;
  preference: Preference;
  goal: string; // free text from the user: untrusted
};

export const REASON_CODES = [
  "HIGHEST_STABLE_YIELD",
  "INSTANT_LIQUIDITY",
  "LOCKUP_OK",
  "LICENSED_RWA",
  "VOLATILE_OPT_IN",
  "DIVERSIFICATION",
  "RISK_CAP",
  "BELOW_MINIMUM",
  "JURISDICTION",
  "SETTLEMENT_TOO_SLOW",
  "VAULT_WHITELIST",
  "VAULT_PAUSED",
  "STABLE_ONLY",
  "MARKET_CLOSED",
  "PRICING_UNRELIABLE",
  "NOT_EXECUTABLE_V1",
  "LOW_SCORE",
  "NO_FUNDS_ON_CHAIN",
  "NO_GAS_ON_CHAIN",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type Split = Record<VenueId, number>; // integer percent per venue, sums to 100

export type Eligibility = {
  venue: VenueId;
  allowed: boolean;
  reasons: ReasonCode[]; // why blocked, or constraints that apply
  maxPct: number; // hard ceiling from the rulebook (0 when blocked)
};

export type Candidate = { id: string; label: string; split: Split; fit: number; why: string };

export type Decision = {
  candidates: Candidate[];
  chosen_id: string;
  blocked: { venue: VenueId; reason: ReasonCode }[];
  reasons: { venue: VenueId; codes: ReasonCode[]; cites: string[] }[];
  summary: string;
};

export type Leg = { venue: VenueId; pct: number; usd: number };

/** A held (or projected) position in one venue, valued in USD. */
export type Position = {
  venue: VenueId;
  usd: number;
  status: "PENDING_T1" | "SETTLED" | "EARNING" | "HELD" | "EMPTY";
  detail: string;
};

export const TRIGGER_CODES = ["DRIFT", "YIELD_GAP", "VAULT_RULE", "NEW_CASH"] as const;
export type TriggerCode = (typeof TRIGGER_CODES)[number];
export type Trigger = { code: TriggerCode; venue?: VenueId; detail: string };
