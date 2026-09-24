// Plans are signed by the server that produced them, so /api/execute only runs plans /api/decide actually issued.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Leg, Profile } from "./types";

const MAX_AGE_MS = 15 * 60 * 1000;

function secret() {
  const s = process.env.PLAN_SECRET;
  if (!s || s.length < 32) throw new Error("PLAN_SECRET is not set (32+ chars).");
  return s;
}

// `wallet` binds a "My wallet" plan to the address it was planned for; demo/operator plans carry none.
function canonical(profile: Profile, legs: Leg[], iat: number, wallet?: string) {
  return JSON.stringify({ p: profile, l: legs.map((x) => [x.venue, x.pct, x.usd]), iat, w: wallet?.toLowerCase() ?? "" });
}

export function signPlan(profile: Profile, legs: Leg[], iat = Date.now(), wallet?: string) {
  return { iat, token: createHmac("sha256", secret()).update(canonical(profile, legs, iat, wallet)).digest("hex") };
}

export function verifyPlan(profile: Profile, legs: Leg[], iat: number, token: string, wallet?: string): string | null {
  if (!Number.isFinite(iat) || Date.now() - iat > MAX_AGE_MS || iat > Date.now() + 60_000) return "This plan has expired. Run the scan again.";
  const expected = Buffer.from(createHmac("sha256", secret()).update(canonical(profile, legs, iat, wallet)).digest("hex"));
  const got = Buffer.from(String(token));
  return expected.length === got.length && timingSafeEqual(expected, got) ? null : "This plan was not issued by this server.";
}

export function passcodeOk(given: string | undefined): boolean {
  const want = process.env.LIVE_PASSCODE;
  if (!want || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Guard-mode move plans are signed the same way, binding the moves to their source and any scenario.
type MovePlan = { moves: { from: string; to: string; usd: number }[]; source: "simulated" | "live"; scenario: boolean; wallet?: string };
function canonicalMoves(p: MovePlan, iat: number) {
  return JSON.stringify({ k: "moves", m: p.moves.map((x) => [x.from, x.to, x.usd]), s: p.source, sc: p.scenario, w: p.wallet?.toLowerCase() ?? "", iat });
}
export function signMoves(p: MovePlan, iat = Date.now()) {
  return { iat, token: createHmac("sha256", secret()).update(canonicalMoves(p, iat)).digest("hex") };
}
export function verifyMoves(p: MovePlan, iat: number, token: string): string | null {
  if (!Number.isFinite(iat) || Date.now() - iat > MAX_AGE_MS || iat > Date.now() + 60_000) return "This proposal has expired. Scan again.";
  const expected = Buffer.from(createHmac("sha256", secret()).update(canonicalMoves(p, iat)).digest("hex"));
  const got = Buffer.from(String(token));
  return expected.length === got.length && timingSafeEqual(expected, got) ? null : "This proposal was not issued by this server.";
}
