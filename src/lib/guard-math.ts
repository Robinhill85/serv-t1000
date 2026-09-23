// Client-side Guard maths: re-basing simulated legs after money moves, and blending targets after a feed.
// Pure functions (tested in guard-math.test.ts); they mirror projectPositions in positions.ts.
import type { VenueId } from "./config";
import type { Signals } from "./signals";
import type { Leg, Position } from "./types";
import type { GuardSession } from "./use-t1000";

/** The growth projectPositions applies since entry, so a re-based leg projects back to exactly the value set. */
export function growth(session: Pick<GuardSession, "entry" | "scenario">, s: Pick<Signals, "rhEth" | "base">, now: number): Record<VenueId, number> {
  const days = Math.max(0, (now - session.entry.at) / 86_400_000);
  const price = (s.rhEth.priceUsd ?? session.entry.ethPriceUsd ?? 0) * (session.scenario?.ethMult ?? 1);
  return {
    ixs: 1,
    rh_stocks: 1,
    base: 1 + ((s.base.netApyPct ?? 0) / 100) * (days / 365),
    rh_eth: session.entry.ethPriceUsd && price ? price / session.entry.ethPriceUsd : 1,
  };
}

/** Simulated legs after money moved: value now plus the change, divided by the growth the projection will apply. */
export function rebase(session: Pick<GuardSession, "entry" | "scenario" | "legs">, data: { signals: Pick<Signals, "rhEth" | "base">; positions: Pick<Position, "venue" | "usd">[] }, delta: Partial<Record<VenueId, number>>, now = Date.now()): Leg[] {
  const g = growth(session, data.signals, now);
  const venues = new Set<VenueId>([...session.legs.map((l) => l.venue), ...(Object.keys(delta) as VenueId[])]);
  return [...venues].map((v) => {
    const pos = data.positions.find((p) => p.venue === v)?.usd ?? 0;
    const pct = session.legs.find((l) => l.venue === v)?.pct ?? 0;
    return { venue: v, pct, usd: Math.round((Math.max(0, pos + (delta[v] ?? 0)) / g[v]) * 100) / 100 };
  });
}

/** Targets after a feed: the old targets over the value held, blended with the fed split; integers summing to 100. */
export function blendTargets(legs: Leg[], heldUsd: number, fed: Leg[]): Partial<Record<VenueId, number>> {
  const fedUsd = fed.reduce((a, l) => a + l.usd, 0);
  const total = heldUsd + fedUsd;
  if (total <= 0) return {};
  const venues = [...new Set([...legs.map((l) => l.venue), ...fed.map((l) => l.venue)])];
  const raw = venues.map((v) => {
    const old = ((legs.find((l) => l.venue === v)?.pct ?? 0) / 100) * heldUsd;
    return { v, x: ((old + (fed.find((l) => l.venue === v)?.usd ?? 0)) / total) * 100 };
  });
  const out = raw.map((r) => ({ v: r.v, n: Math.floor(r.x), rem: r.x - Math.floor(r.x) }));
  let left = 100 - out.reduce((a, r) => a + r.n, 0);
  for (const r of [...out].sort((a, b) => b.rem - a.rem)) { if (left <= 0) break; r.n++; left--; }
  return Object.fromEntries(out.map((r) => [r.v, r.n]));
}
