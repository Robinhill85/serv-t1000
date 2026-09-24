// Application-side guard: the last check between a model's decision and a signed transaction.
import { VENUES, VENUE_IDS, type ChainKey, type VenueId } from "./config";
import { moveChain, type Move } from "./rebalance";
import { LIQUIDITY_BUFFER_PCT, minPctFor, volatileCap } from "./rulebook";
import type { Eligibility, Leg, Position, Profile, Split } from "./types";

type Elig = Record<VenueId, Eligibility>;

export const emptySplit = (): Split => ({ ixs: 0, base: 0, rh_eth: 0, rh_stocks: 0 });

const volatileIds = VENUE_IDS.filter((id) => VENUES[id].kind === "volatile");
const sum = (s: Split) => VENUE_IDS.reduce((a, id) => a + s[id], 0);

/**
 * Deterministic repair of a model split so it satisfies the rulebook.
 * Every change is reported; the UI shows them as "GUARD ADJUSTED" lines.
 * Freed weight always flows to Base USDC lending (always eligible, instant).
 */
export function enforce(input: Split, profile: Profile, elig: Elig): { split: Split; adjustments: string[] } {
  const split = emptySplit();
  const adjustments: string[] = [];
  for (const id of VENUE_IDS) split[id] = Math.max(0, Math.round(Number(input[id]) || 0));

  for (const id of VENUE_IDS) {
    if (split[id] > 0 && !elig[id].allowed) {
      adjustments.push(`${VENUES[id].hud}: ${split[id]}% removed (${elig[id].reasons[0]})`);
      split.base += split[id];
      split[id] = 0;
    }
  }

  // Each venue's ceiling (rules, and in wallet mode what the wallet holds on that chain) is enforced here, not trusted
  // to the model. The excess goes to Base; if Base itself can't hold it, checkExecutable refuses the plan.
  for (const id of VENUE_IDS) {
    if (id === "base" || split[id] <= elig[id].maxPct) continue;
    const cut = split[id] - elig[id].maxPct;
    split[id] -= cut;
    split.base += cut;
    adjustments.push(`${VENUES[id].hud}: cut ${cut}% to its ${elig[id].maxPct}% ceiling`);
  }

  const cap = volatileCap(profile);
  let vol = volatileIds.reduce((a, id) => a + split[id], 0);
  for (const id of volatileIds) {
    if (vol <= cap) break;
    const cut = Math.min(split[id], vol - cap);
    if (cut > 0) {
      split[id] -= cut;
      split.base += cut;
      vol -= cut;
      adjustments.push(`${VENUES[id].hud}: cut ${cut}% to volatile cap ${cap}%`);
    }
  }

  for (const id of VENUE_IDS) {
    if (id === "base" || split[id] === 0) continue;
    const min = minPctFor(id, profile.amountUsd);
    if (split[id] < min) {
      adjustments.push(`${VENUES[id].hud}: ${split[id]}% is below the $${VENUES[id].minUsd} minimum, moved to Base`);
      split.base += split[id];
      split[id] = 0;
    }
  }

  // Liquidity buffer: top Base up to 20%, taking from volatile legs first, then from others only while they
  // stay at or above their minimum; a leg that can't give without breaching its minimum is moved whole.
  // (Only when Base can hold the buffer: a wallet with little USDC on Base can't be topped up there.)
  if (elig.base.allowed && elig.base.maxPct >= LIQUIDITY_BUFFER_PCT && split.base < LIQUIDITY_BUFFER_PCT) {
    const before = split.base;
    let need = LIQUIDITY_BUFFER_PCT - split.base;
    const donors = [...volatileIds, ...VENUE_IDS.filter((id) => id !== "base" && !volatileIds.includes(id))];
    for (const id of donors) {
      if (need <= 0) break;
      const floor = VENUES[id].kind === "volatile" ? 0 : minPctFor(id, profile.amountUsd);
      const give = Math.min(need, Math.max(0, split[id] - floor));
      split[id] -= give; split.base += give; need -= give;
    }
    for (const id of donors) {
      if (need <= 0) break;
      if (split[id] > 0 && id !== "base") { need -= split[id]; split.base += split[id]; split[id] = 0; }
    }
    for (const id of VENUE_IDS) {
      if (id !== "base" && split[id] > 0 && split[id] < minPctFor(id, profile.amountUsd)) { split.base += split[id]; split[id] = 0; }
    }
    adjustments.push(`BASE USDC LENDING: raised from ${before}% to ${split.base}% (${LIQUIDITY_BUFFER_PCT}% liquidity buffer)`);
  }

  const total = sum(split);
  if (total !== 100) {
    split.base += 100 - total;
    if (split.base < 0) {
      // Model over-allocated: scale the non-base legs down proportionally.
      const others = VENUE_IDS.filter((id) => id !== "base");
      const over = -split.base;
      split.base = 0;
      let remaining = over;
      for (const id of others) {
        const cut = Math.min(split[id], Math.ceil((split[id] / (100 + over)) * over), remaining);
        split[id] -= cut;
        remaining -= cut;
      }
      split.base += 100 - sum(split);
    }
    adjustments.push(`Split normalised to 100% (model returned ${total}%)`);
  }
  return { split, adjustments };
}

/** Rule breaks in a raw model split, before any repair. This is the T-800 vs T-1000 scoreboard. */
export function audit(input: Split, profile: Profile, elig: Elig): string[] {
  const out: string[] = [];
  const total = sum(input);
  if (total !== 100) out.push(`split sums to ${total}%`);
  for (const id of VENUE_IDS) {
    if (input[id] > 0 && !elig[id].allowed) out.push(`${VENUES[id].hud} allocated while blocked (${elig[id].reasons[0]})`);
    else if (input[id] > 0 && id !== "base" && input[id] < minPctFor(id, profile.amountUsd)) out.push(`${VENUES[id].hud} below its $${VENUES[id].minUsd} minimum`);
  }
  const cap = volatileCap(profile);
  const vol = volatileIds.reduce((a, id) => a + input[id], 0);
  if (vol > cap) out.push(`volatile ${vol}% over the ${cap}% cap`);
  if (elig.base.allowed && input.base < LIQUIDITY_BUFFER_PCT) out.push(`Base buffer ${input.base}% under ${LIQUIDITY_BUFFER_PCT}%`);
  return out;
}

/** Percent split to dollar legs. Cents are floored; the remainder goes to the largest leg. */
export function toLegs(split: Split, amountUsd: number): Leg[] {
  const legs = VENUE_IDS.filter((id) => split[id] > 0).map((id) => ({
    venue: id,
    pct: split[id],
    usd: Math.floor(amountUsd * split[id]) / 100,
  }));
  const rest = Math.round((amountUsd - legs.reduce((a, l) => a + l.usd, 0)) * 100) / 100;
  if (legs.length && rest !== 0) {
    const biggest = legs.reduce((a, l) => (l.usd > a.usd ? l : a));
    biggest.usd = Math.round((biggest.usd + rest) * 100) / 100;
  }
  return legs;
}

export type Limits = { enabled: boolean; maxRunUsd: number };

/** Strict pre-execution check. Returns the list of violations; empty means safe to execute. */
export function checkExecutable(legs: Leg[], profile: Profile, elig: Elig, limits: Limits): string[] {
  const errors: string[] = [];
  if (!limits.enabled) errors.push("Execution is disabled (kill switch).");
  const total = Math.round(legs.reduce((a, l) => a + l.usd, 0) * 100) / 100;
  if (Math.abs(total - profile.amountUsd) > 0.01) errors.push(`Legs total $${total}, expected $${profile.amountUsd}.`);
  if (total > limits.maxRunUsd) errors.push(`Run total $${total} exceeds the $${limits.maxRunUsd} cap.`);
  if (legs.reduce((a, l) => a + l.pct, 0) !== 100) errors.push("Leg percentages do not sum to 100.");
  const cap = volatileCap(profile);
  const vol = legs.filter((l) => VENUES[l.venue].kind === "volatile").reduce((a, l) => a + l.pct, 0);
  if (vol > cap) errors.push(`Volatile legs ${vol}% exceed the ${cap}% cap.`);
  const basePct = legs.find((l) => l.venue === "base")?.pct ?? 0;
  if (elig.base.allowed && elig.base.maxPct >= LIQUIDITY_BUFFER_PCT && basePct < LIQUIDITY_BUFFER_PCT) errors.push(`Base buffer ${basePct}% is under ${LIQUIDITY_BUFFER_PCT}%.`);
  for (const l of legs) {
    const v = VENUES[l.venue];
    if (!elig[l.venue].allowed) errors.push(`${v.hud} is blocked (${elig[l.venue].reasons.join(", ")}).`);
    else if (l.pct > elig[l.venue].maxPct) errors.push(`${v.hud} needs ${l.pct}% but can take at most ${elig[l.venue].maxPct}% (${elig[l.venue].reasons.includes("NO_FUNDS_ON_CHAIN") ? "the wallet's funds on that chain" : "rulebook ceiling"}).`);
    if (!v.executable) errors.push(`${v.hud} is not executable in this version.`);
    if (l.usd < v.minUsd) errors.push(`${v.hud} leg $${l.usd} is below the $${v.minUsd} minimum.`);
    if (l.usd <= 0) errors.push(`${v.hud} leg is not positive.`);
  }
  return errors;
}

// ---------- Guard-mode moves ----------

export type MoveCheck = { executable: Move[]; deferred: Move[]; errors: string[] };

/**
 * Hard rules for a rebalance: same chain only (a venue <-> that chain's idle), amounts within the position or the
 * chain's idle funds, the IXS minimums, no exit from an IXS deposit that is still settling, $5 floor, and the
 * volatile share within its cap afterwards. Moves that need a bridge are deferred, never executed.
 */
export function checkMoves(
  moves: Move[],
  positions: Position[],
  idleByChain: Partial<Record<ChainKey, number>>,
  profile: Pick<Profile, "preference" | "risk">,
  opts: { ixsRedeemMinUsd: number } = { ixsRedeemMinUsd: 0 },
): MoveCheck {
  const executable: Move[] = [];
  const deferred: Move[] = [];
  const errors: string[] = [];
  const pos = new Map(positions.map((p) => [p.venue, p]));
  const after = new Map(positions.map((p) => [p.venue, p.usd]));
  const idle = { ...idleByChain };

  for (const m of moves) {
    const chain = moveChain(m);
    if (m.bridge_required || chain == null) { deferred.push(m); continue; }
    if (m.usd < 5) { errors.push(`Move of $${m.usd} is under the $5 floor.`); continue; }
    const venue = (m.from === "idle" ? m.to : m.from) as VenueId;
    if (!VENUES[venue].executable) { errors.push(`${VENUES[venue].hud} is not executable.`); continue; }
    if (m.from !== "idle") {
      const p = pos.get(venue);
      if (!p || m.usd > p.usd * 1.005) { errors.push(`${VENUES[venue].hud}: move $${m.usd} exceeds the $${p?.usd ?? 0} position.`); continue; }
      if (venue === "ixs" && p.status === "PENDING_T1") { errors.push("IXS deposit is still settling (T+1): nothing to redeem yet."); continue; }
      if (venue === "ixs" && m.usd < opts.ixsRedeemMinUsd) { errors.push(`IXS exit $${m.usd} is under the $${opts.ixsRedeemMinUsd} minimum.`); continue; }
      after.set(venue, (after.get(venue) ?? 0) - m.usd);
      idle[chain] = (idle[chain] ?? 0) + m.usd;
    } else {
      if (m.usd > (idle[chain] ?? 0) + 0.01) { errors.push(`${VENUES[venue].hud}: only $${(idle[chain] ?? 0).toFixed(2)} idle on ${chain}.`); continue; }
      if (venue === "ixs" && m.usd < VENUES.ixs.minUsd) { errors.push(`IXS deposit $${m.usd} is under the $${VENUES.ixs.minUsd} minimum.`); continue; }
      after.set(venue, (after.get(venue) ?? 0) + m.usd);
      idle[chain] = (idle[chain] ?? 0) - m.usd;
    }
    executable.push(m);
  }

  const total = [...after.values()].reduce((a, v) => a + Math.max(0, v), 0);
  const vol = [...after.entries()].filter(([v]) => VENUES[v].kind === "volatile").reduce((a, [, v]) => a + Math.max(0, v), 0);
  const cap = volatileCap(profile);
  if (total > 0 && executable.length && (vol / total) * 100 > cap + 0.5) {
    errors.push(`After these moves the volatile share would be ${((vol / total) * 100).toFixed(1)}%, over the ${cap}% cap.`);
  }
  return { executable, deferred, errors };
}
