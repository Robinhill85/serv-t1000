import { describe, expect, it } from "vitest";
import { checkExecutable, enforce, toLegs } from "./plan-guard";
import { eligibility, type RuleInputs } from "./rulebook";
import type { Profile } from "./types";

const open: RuleInputs = { ixs: { paused: false, whitelistEnabled: false, agentWhitelisted: false }, usMarketOpen: true };
const limits = { enabled: true, maxRunUsd: 500 };
const uk: Profile = {
  residence: "UK", amountUsd: 300, horizon: "3_12m", risk: "medium", instantAccess: false, preference: "mixed", goal: "",
};

describe("rulebook", () => {
  it("blocks Stock Tokens for UK and US residents on jurisdiction", () => {
    expect(eligibility(uk, open).rh_stocks.reasons).toContain("JURISDICTION");
    expect(eligibility({ ...uk, residence: "US" }, open).rh_stocks.allowed).toBe(false);
  });
  it("keeps Stock Tokens out of v1 execution for EU residents", () => {
    const e = eligibility({ ...uk, residence: "EU" }, open).rh_stocks;
    expect(e.allowed).toBe(false);
    expect(e.reasons).toContain("NOT_EXECUTABLE_V1");
  });
  it("excludes IXS when the user needs instant access", () => {
    const e = eligibility({ ...uk, instantAccess: true }, open).ixs;
    expect(e.allowed).toBe(false);
    expect(e.reasons).toContain("SETTLEMENT_TOO_SLOW");
  });
  it("excludes IXS below its $100 minimum and when the whitelist is on", () => {
    expect(eligibility({ ...uk, amountUsd: 80 }, open).ixs.reasons).toContain("BELOW_MINIMUM");
    const wl = { ...open, ixs: { paused: false, whitelistEnabled: true, agentWhitelisted: false } };
    expect(eligibility(uk, wl).ixs.reasons).toContain("VAULT_WHITELIST");
  });
  it("blocks volatile legs for stable-only savers", () => {
    expect(eligibility({ ...uk, preference: "stable" }, open).rh_eth.reasons).toContain("STABLE_ONLY");
  });
});

describe("enforce", () => {
  it("moves blocked weight to Base and reports it", () => {
    const profile = { ...uk, instantAccess: true };
    const r = enforce({ ixs: 60, base: 30, rh_eth: 10, rh_stocks: 0 }, profile, eligibility(profile, open));
    expect(r.split).toEqual({ ixs: 0, base: 90, rh_eth: 10, rh_stocks: 0 });
    expect(r.adjustments.join(" ")).toContain("SETTLEMENT_TOO_SLOW");
  });
  it("cuts volatile legs to the risk cap", () => {
    const r = enforce({ ixs: 40, base: 20, rh_eth: 40, rh_stocks: 0 }, uk, eligibility(uk, open));
    expect(r.split.rh_eth).toBe(20);
    expect(r.split.base).toBe(40);
  });
  it("moves an IXS leg under $100 to Base", () => {
    const profile = { ...uk, amountUsd: 150 };
    const r = enforce({ ixs: 50, base: 40, rh_eth: 10, rh_stocks: 0 }, profile, eligibility(profile, open));
    expect(r.split.ixs).toBe(0);
    expect(r.split.base).toBe(90);
  });
  it("normalises splits that do not sum to 100", () => {
    const r = enforce({ ixs: 70, base: 50, rh_eth: 10, rh_stocks: 0 }, uk, eligibility(uk, open));
    expect(Object.values(r.split).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("liquidity buffer", () => {
  it("tops Base up to 20% from the volatile leg first, keeping IXS at its minimum", () => {
    const profile = { ...uk, amountUsd: 150, risk: "high" as const, preference: "volatile" as const };
    const r = enforce({ ixs: 67, base: 1, rh_eth: 32, rh_stocks: 0 }, profile, eligibility(profile, open));
    expect(r.split).toEqual({ ixs: 67, base: 20, rh_eth: 13, rh_stocks: 0 });
    expect(r.adjustments.join(" ")).toMatch(/liquidity buffer/);
  });
  it("moves IXS out entirely when the buffer and its $100 minimum can't both fit", () => {
    const r = enforce({ ixs: 100, base: 0, rh_eth: 0, rh_stocks: 0 }, { ...uk, amountUsd: 110 }, eligibility({ ...uk, amountUsd: 110 }, open));
    expect(r.split).toEqual({ ixs: 0, base: 100, rh_eth: 0, rh_stocks: 0 });
  });
});

describe("checkExecutable", () => {
  const elig = eligibility(uk, open);
  it("passes a clean plan", () => {
    const legs = toLegs({ ixs: 50, base: 35, rh_eth: 15, rh_stocks: 0 }, 300);
    expect(legs.map((l) => l.usd)).toEqual([150, 105, 45]);
    expect(checkExecutable(legs, uk, elig, limits)).toEqual([]);
  });
  it("refuses when the kill switch is off", () => {
    const legs = toLegs({ ixs: 50, base: 50, rh_eth: 0, rh_stocks: 0 }, 300);
    expect(checkExecutable(legs, uk, elig, { ...limits, enabled: false })[0]).toMatch(/kill switch/);
  });
  it("refuses runs above the spend cap", () => {
    const legs = toLegs({ ixs: 50, base: 50, rh_eth: 0, rh_stocks: 0 }, 300);
    expect(checkExecutable(legs, uk, elig, { enabled: true, maxRunUsd: 150 }).join()).toMatch(/exceeds/);
  });
  it("refuses blocked and non-executable venues", () => {
    const legs = toLegs({ ixs: 0, base: 80, rh_eth: 0, rh_stocks: 20 }, 300);
    const errs = checkExecutable(legs, uk, elig, limits).join(" ");
    expect(errs).toMatch(/JURISDICTION/);
    expect(errs).toMatch(/not executable/);
  });
});
