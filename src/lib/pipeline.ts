// The full think step: signals -> rulebook -> Jev -> SERV decision -> guard. Emits events for the HUD as it goes.
import type { Address } from "viem";
import { VENUE_IDS, type VenueId } from "./config";
import { decide, decisionInput, type DecideResult } from "./decide";
import { jevScores, type JevResult } from "./jev";
import { audit, enforce, toLegs } from "./plan-guard";
import { eligibility, minPctFor, volatileCap } from "./rulebook";
import { getSignals, type Signals } from "./signals";
import type { Eligibility, Leg, Profile, Split } from "./types";

export type PipelineEvent =
  | { type: "signals"; signals: Signals }
  | { type: "eligibility"; eligibility: Record<VenueId, Eligibility> }
  | { type: "jev"; jev: JevResult }
  | { type: "decision_fast"; result: DecideResult; violations: string[]; split: Split | null; legs: Leg[] }
  | { type: "decision_verified"; result: DecideResult; violations: string[]; revised: boolean }
  | { type: "plan"; split: Split; legs: Leg[]; adjustments: string[]; verified: boolean }
  | { type: "error"; message: string };

export type PipelineOptions = { agent?: Address; now?: Date };

function chosenSplit(r: DecideResult): Split | null {
  const d = r.decision;
  if (!d) return null;
  return (d.candidates.find((c) => c.id === d.chosen_id) ?? d.candidates[0])?.split ?? null;
}

export async function runPipeline(profile: Profile, emit: (e: PipelineEvent) => void, opts: PipelineOptions = {}) {
  const signals = await getSignals(opts.agent, opts.now);
  emit({ type: "signals", signals });

  const elig = eligibility(profile, {
    ixs: { paused: signals.ixs.paused, whitelistEnabled: signals.ixs.whitelistEnabled, agentWhitelisted: signals.ixs.agentWhitelisted },
    usMarketOpen: signals.market.usMarketOpen,
  });
  emit({ type: "eligibility", eligibility: elig });

  // Jev runs alongside the fast draft (its latency varies 0.6-10s). The draft reasons from raw signals;
  // the verifier sees Jev's scores when it checks the draft.
  const jevP = jevScores(profile, signals).then((jev) => { emit({ type: "jev", jev }); return jev; });
  const minPct = Object.fromEntries(VENUE_IDS.map((id) => [id, minPctFor(id, profile.amountUsd)])) as Record<VenueId, number>;
  const pending: JevResult = { status: "UNAVAILABLE", model: null, ms: 0, scores: {} };
  const draftInput = decisionInput(profile, elig, signals, pending, minPct, volatileCap(profile));

  // Two phases: the fast Multipath call reveals the split; the verified call (Prompt Guard + Shadow Agent)
  // checks that draft and gates execution. It only changes the split when the draft breaks a rule or the policy.
  const fast = await decide(draftInput, "fast");
  const fastSplit = chosenSplit(fast);
  const fastPlan = fastSplit ? enforce(fastSplit, profile, elig).split : null;
  emit({
    type: "decision_fast", result: fast, violations: fastSplit ? audit(fastSplit, profile, elig) : ["no decision"],
    split: fastPlan, legs: fastPlan ? toLegs(fastPlan, profile.amountUsd) : [],
  });

  const jev = await jevP;
  const verified = await decide(decisionInput(profile, elig, signals, jev, minPct, volatileCap(profile)), "verified", fast.decision ?? undefined);
  const vSplit = chosenSplit(verified);
  const revised = !!(vSplit && fastPlan && VENUE_IDS.some((id) => enforce(vSplit, profile, elig).split[id] !== fastPlan[id]));
  emit({ type: "decision_verified", result: verified, violations: vSplit ? audit(vSplit, profile, elig) : ["no decision"], revised });

  // Execution only ever uses the verified decision. If verification failed, the fast split is shown but stays unapproved.
  const source = vSplit ?? fastSplit;
  if (!source) {
    emit({ type: "error", message: verified.error ?? fast.error ?? "SERV returned no decision." });
    return;
  }
  const { split, adjustments } = enforce(source, profile, elig);
  emit({ type: "plan", split, legs: toLegs(split, profile.amountUsd), adjustments, verified: !!vSplit });
}
