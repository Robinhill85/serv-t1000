import { describe, expect, it } from "vitest";
import { checkMoves } from "./plan-guard";
import type { Position } from "./types";

const profile = { preference: "mixed" as const, risk: "medium" as const };
const positions: Position[] = [
  { venue: "ixs", usd: 100.5, status: "SETTLED", detail: "" },
  { venue: "base", usd: 30, status: "EARNING", detail: "" },
  { venue: "rh_eth", usd: 42, status: "HELD", detail: "" },
];
const idle = { base: 20, avalanche: 5, robinhood: 0 };

describe("checkMoves", () => {
  it("allows trimming ETH to idle on Robinhood Chain", () => {
    const r = checkMoves([{ from: "rh_eth", to: "idle", usd: 20, bridge_required: false, why: "" }], positions, idle, profile);
    expect(r.errors).toEqual([]);
    expect(r.executable).toHaveLength(1);
  });
  it("defers cross-chain moves instead of executing them", () => {
    const r = checkMoves([{ from: "rh_eth", to: "base", usd: 20, bridge_required: true, why: "" }], positions, idle, profile);
    expect(r.deferred).toHaveLength(1);
    expect(r.executable).toHaveLength(0);
  });
  it("defers a venue-to-venue move even if the model forgot bridge_required", () => {
    const r = checkMoves([{ from: "ixs", to: "base", usd: 50, bridge_required: false, why: "" }], positions, idle, profile);
    expect(r.deferred).toHaveLength(1);
  });
  it("refuses a move larger than the position", () => {
    const r = checkMoves([{ from: "base", to: "idle", usd: 60, bridge_required: false, why: "" }], positions, idle, profile);
    expect(r.errors.join()).toMatch(/exceeds/);
  });
  it("refuses an IXS exit while the deposit is still settling", () => {
    const pending = positions.map((p) => (p.venue === "ixs" ? { ...p, status: "PENDING_T1" as const } : p));
    const r = checkMoves([{ from: "ixs", to: "idle", usd: 50, bridge_required: false, why: "" }], pending, idle, profile);
    expect(r.errors.join()).toMatch(/settling/);
  });
  it("refuses IXS deposits under $100 and idle it does not have", () => {
    expect(checkMoves([{ from: "idle", to: "ixs", usd: 5, bridge_required: false, why: "" }], positions, idle, profile).errors.join()).toMatch(/only \$5\.00 idle|minimum/);
    expect(checkMoves([{ from: "idle", to: "base", usd: 25, bridge_required: false, why: "" }], positions, idle, profile).errors.join()).toMatch(/only \$20\.00 idle/);
  });
  it("refuses moves that leave the volatile share over its cap", () => {
    const r = checkMoves([{ from: "base", to: "idle", usd: 30, bridge_required: false, why: "" }], positions, idle, profile);
    expect(r.errors.join()).toMatch(/over the 20% cap/);
  });
});
