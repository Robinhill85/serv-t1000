import { describe, expect, it } from "vitest";
import { triggers } from "./rulebook";
import type { Position } from "./types";

const base = {
  targets: { ixs: 67, base: 20, rh_eth: 13, rh_stocks: 0 },
  profile: { preference: "mixed" as const, risk: "medium" as const },
  baseApyPct: 4.4,
  ixsYieldPct: 6,
  ixs: { paused: false, whitelistEnabled: false, agentWhitelisted: false, navFresh: true },
  idleNowUsd: 100,
  idleAtDeployUsd: 100,
};
const pos = (ixs: number, b: number, eth: number): Position[] => [
  { venue: "ixs", usd: ixs, status: "PENDING_T1", detail: "" },
  { venue: "base", usd: b, status: "EARNING", detail: "" },
  { venue: "rh_eth", usd: eth, status: "HELD", detail: "" },
];

describe("guard triggers", () => {
  it("stays quiet when positions match the targets", () => {
    expect(triggers({ ...base, positions: pos(100.5, 30, 19.5) })).toEqual([]);
  });
  it("fires DRIFT when ETH runs and the volatile share breaks its cap", () => {
    const t = triggers({ ...base, positions: pos(100.5, 30, 19.5 * 2.2) });
    expect(t.map((x) => x.code)).toContain("DRIFT");
    expect(t.some((x) => x.detail.includes("over the 20% cap"))).toBe(true);
  });
  it("fires YIELD_GAP when Base lending closes on IXS", () => {
    expect(triggers({ ...base, baseApyPct: 5.5, positions: pos(100.5, 30, 19.5) }).map((x) => x.code)).toEqual(["YIELD_GAP"]);
  });
  it("fires VAULT_RULE when IXS pauses or turns its whitelist on", () => {
    const t = triggers({ ...base, ixs: { ...base.ixs, whitelistEnabled: true }, positions: pos(100.5, 30, 19.5) });
    expect(t.map((x) => x.code)).toEqual(["VAULT_RULE"]);
  });
  it("fires NEW_CASH for $20+ of new idle stables", () => {
    expect(triggers({ ...base, idleNowUsd: 125, positions: pos(100.5, 30, 19.5) }).map((x) => x.code)).toEqual(["NEW_CASH"]);
    expect(triggers({ ...base, idleNowUsd: 110, positions: pos(100.5, 30, 19.5) })).toEqual([]);
  });
});
