import { describe, expect, it } from "vitest";
import { signPlan, verifyPlan } from "./plan-token";
import { checkExecutable, enforce } from "./plan-guard";
import { eligibility } from "./rulebook";
import type { Leg, Profile } from "./types";

process.env.PLAN_SECRET = process.env.PLAN_SECRET ?? "test-secret-that-is-at-least-32-characters-long";

const profile: Profile = { residence: "UK", amountUsd: 100, horizon: "3_12m", risk: "medium", instantAccess: false, preference: "mixed", goal: "" };
const ixsOpen = { paused: false, whitelistEnabled: false, agentWhitelisted: false };
const legs: Leg[] = [{ venue: "base", pct: 80, usd: 80 }, { venue: "rh_eth", pct: 20, usd: 20 }];
const A = "0x2C12CF9dcb6C4958216e7eCe4c71a2Ebc3db358a";
const B = "0x000000000000000000000000000000000000bEEF";

describe("wallet-bound plan tokens", () => {
  it("verify only for the wallet they were signed for", () => {
    const { iat, token } = signPlan(profile, legs, Date.now(), A);
    expect(verifyPlan(profile, legs, iat, token, A)).toBeNull();
    expect(verifyPlan(profile, legs, iat, token, A.toLowerCase())).toBeNull();
    expect(verifyPlan(profile, legs, iat, token, B)).not.toBeNull();
    expect(verifyPlan(profile, legs, iat, token)).not.toBeNull(); // not usable on the operator path
  });
  it("demo/operator plans don't verify as wallet plans", () => {
    const { iat, token } = signPlan(profile, legs);
    expect(verifyPlan(profile, legs, iat, token)).toBeNull();
    expect(verifyPlan(profile, legs, iat, token, A)).not.toBeNull();
  });
});

describe("eligibility from the user's wallet", () => {
  it("blocks a chain with funds but no gas, and a chain below the venue minimum", () => {
    const e = eligibility(profile, { ixs: ixsOpen, usMarketOpen: true, chainFunds: { base: 90, avalanche: 16, robinhood: 45 }, chainGas: { base: 0.001, avalanche: 1, robinhood: 0 } });
    expect(e.ixs.allowed).toBe(false);
    expect(e.ixs.reasons).toContain("NO_FUNDS_ON_CHAIN"); // $16 < $100 minimum
    expect(e.rh_eth.allowed).toBe(false);
    expect(e.rh_eth.reasons).toContain("NO_GAS_ON_CHAIN");
    expect(e.base.allowed).toBe(true);
    expect(e.base.maxPct).toBe(90);
  });
  it("demo plans (no wallet funds) are not capped", () => {
    const e = eligibility(profile, { ixs: ixsOpen, usMarketOpen: true });
    expect(e.ixs.allowed).toBe(true);
  });
});

describe("venue ceilings are enforced in code", () => {
  const elig = eligibility(profile, { ixs: ixsOpen, usMarketOpen: true, chainFunds: { base: 10, avalanche: 500, robinhood: 50 }, chainGas: { base: 1, avalanche: 1, robinhood: 1 } });
  it("enforce clamps a venue to its ceiling (excess to Base)", () => {
    const { split } = enforce({ ixs: 0, base: 10, rh_eth: 90, rh_stocks: 0 }, profile, elig);
    expect(split.rh_eth).toBeLessThanOrEqual(elig.rh_eth.maxPct);
  });
  it("checkExecutable refuses a leg the wallet can't fund, and skips the Base buffer when Base can't hold it", () => {
    const errs = checkExecutable([{ venue: "ixs", pct: 70, usd: 70 }, { venue: "base", pct: 30, usd: 30 }], profile, elig, { enabled: true, maxRunUsd: 500 });
    expect(errs.some((e) => e.includes("BASE USDC LENDING needs 30%"))).toBe(true);
    expect(errs.some((e) => e.includes("Base buffer"))).toBe(false); // Base can only take 10%: no 20% buffer demand
  });
  it("the public cap applies", () => {
    const big = { ...profile, amountUsd: 600 };
    const errs = checkExecutable([{ venue: "base", pct: 100, usd: 600 }], big, eligibility(big, { ixs: ixsOpen, usMarketOpen: true }), { enabled: true, maxRunUsd: 500 });
    expect(errs.some((e) => e.includes("exceeds the $500 cap"))).toBe(true);
  });
});

describe("small wallets", () => {
  it("$2 of USDC on Base (with gas) is a valid Base-only plan", () => {
    const small = { ...profile, amountUsd: 2 };
    const e = eligibility(small, { ixs: ixsOpen, usMarketOpen: true, chainFunds: { base: 2 }, chainGas: { base: 0.001 } });
    expect(e.base.allowed).toBe(true);
    expect(e.ixs.allowed).toBe(false);
    expect(e.rh_eth.allowed).toBe(false);
    const { split } = enforce({ ixs: 0, base: 100, rh_eth: 0, rh_stocks: 0 }, small, e);
    expect(split.base).toBe(100);
    expect(checkExecutable([{ venue: "base", pct: 100, usd: 2 }], small, e, { enabled: true, maxRunUsd: 500 })).toEqual([]);
  });
  it("$2 on Base without ETH for gas is blocked with a clear reason", () => {
    const small = { ...profile, amountUsd: 2 };
    const e = eligibility(small, { ixs: ixsOpen, usMarketOpen: true, chainFunds: { base: 2 }, chainGas: { base: 0 } });
    expect(e.base.allowed).toBe(false);
    expect(e.base.reasons).toContain("NO_GAS_ON_CHAIN");
  });
});
