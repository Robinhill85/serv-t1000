import { describe, expect, it } from "vitest";
import { blendTargets, growth, rebase } from "./guard-math";
import type { Leg, Position } from "./types";

const DAY = 86_400_000;
const signals = (ethPrice: number, apy = 4.4) => ({ rhEth: { priceUsd: ethPrice }, base: { netApyPct: apy } }) as Parameters<typeof growth>[1];
const pos = (venue: Position["venue"], usd: number): Position => ({ venue, usd, status: "HELD", detail: "" });

describe("growth", () => {
  it("mirrors projectPositions: ETH by price (and scenario), Base by APY over time, IXS flat", () => {
    const now = Date.now();
    const g = growth({ entry: { at: now - 365 * DAY, ethPriceUsd: 2000, idleUsd: 0 }, scenario: { ethMult: 1.5 } }, signals(2400), now);
    expect(g.rh_eth).toBeCloseTo(1.8); // 2400 * 1.5 / 2000
    expect(g.base).toBeCloseTo(1.044);
    expect(g.ixs).toBe(1);
  });
});

describe("rebase", () => {
  const now = Date.now();
  const legs: Leg[] = [{ venue: "ixs", pct: 76, usd: 114 }, { venue: "base", pct: 20, usd: 30 }, { venue: "rh_eth", pct: 4, usd: 6 }];

  it("a trim under a scenario projects back to exactly the trimmed value", () => {
    const session = { legs, entry: { at: now, ethPriceUsd: 2000, idleUsd: 0 }, scenario: { ethMult: 2.4 } };
    const out = rebase(session, { signals: signals(2000), positions: [pos("ixs", 114), pos("base", 30), pos("rh_eth", 14.4)] }, { rh_eth: -8 }, now);
    const eth = out.find((l) => l.venue === "rh_eth")!;
    expect(eth.pct).toBe(4); // targets never move on a rebalance
    expect(eth.usd * 2.4).toBeCloseTo(6.4, 1);
    expect(out.find((l) => l.venue === "ixs")!.usd).toBe(114);
  });

  it("removes a year of Base accrual so the projection does not count it twice", () => {
    const session = { legs, entry: { at: now - 365 * DAY, ethPriceUsd: 2000, idleUsd: 0 }, scenario: null };
    const out = rebase(session, { signals: signals(2000), positions: [pos("base", 31.32)] }, {}, now);
    expect(out.find((l) => l.venue === "base")!.usd).toBeCloseTo(30, 2);
  });

  it("adds a venue that was not in the plan and never goes negative", () => {
    const session = { legs: [legs[0]], entry: { at: now, ethPriceUsd: 2000, idleUsd: 0 }, scenario: null };
    const out = rebase(session, { signals: signals(2000), positions: [pos("ixs", 114)] }, { base: 20, ixs: -500 }, now);
    expect(out.find((l) => l.venue === "base")).toEqual({ venue: "base", pct: 0, usd: 20 });
    expect(out.find((l) => l.venue === "ixs")!.usd).toBe(0);
  });
});

describe("blendTargets", () => {
  it("weights the old targets by value held and the feed by its amount; integers summing to 100", () => {
    const legs: Leg[] = [{ venue: "ixs", pct: 76, usd: 114 }, { venue: "base", pct: 20, usd: 30 }, { venue: "rh_eth", pct: 4, usd: 6 }];
    const t = blendTargets(legs, 150, [{ venue: "base", pct: 75, usd: 15 }, { venue: "rh_eth", pct: 25, usd: 5 }]);
    expect(t.ixs! + t.base! + t.rh_eth!).toBe(100);
    expect(t.ixs).toBe(67); // 114 / 170
    expect(t.base).toBeGreaterThanOrEqual(26);
    expect(t.rh_eth).toBeGreaterThanOrEqual(6);
  });

  it("with nothing held the targets are the fed split", () => {
    expect(blendTargets([{ venue: "ixs", pct: 100, usd: 100 }], 0, [{ venue: "base", pct: 100, usd: 20 }])).toEqual({ ixs: 0, base: 100 });
  });
});
