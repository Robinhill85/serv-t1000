// Guard state on the server: positions (real or projected), triggers, and idle funds by chain.
import type { Address } from "viem";
import type { ChainKey } from "./config";
import { agentAddress } from "./execute";
import { projectPositions, readAgentPositions, type Entry, type Scenario } from "./positions";
import { triggers as runTriggers } from "./rulebook";
import { scanWallet } from "./scan";
import { getSignals, type Signals } from "./signals";
import type { Leg, Position, Profile, Split, Trigger } from "./types";

export type GuardRequest = {
  source: "simulated" | "live";
  profile: Pick<Profile, "preference" | "risk" | "horizon" | "instantAccess">;
  legs: Leg[];
  entry: Entry;
  scenario: Scenario;
  address?: string;
};
export type GuardState = {
  source: "simulated" | "live";
  positions: Position[];
  targets: Split;
  triggers: Trigger[];
  idleUsd: number;
  /** Baseline for NEW_CASH: the request's, or this scan's idle when the request has none yet. */
  idleAtDeployUsd: number;
  idleByChain: Partial<Record<ChainKey, number>>;
  signals: Signals;
  scenario: Scenario;
  at: string;
};

export async function guardState(req: GuardRequest): Promise<GuardState> {
  const agent = (req.address as Address | undefined) ?? agentAddress();
  const [s, scan] = await Promise.all([getSignals(agent), scanWallet(agent)]);
  const idleByChain: Partial<Record<ChainKey, number>> = {};
  for (const h of scan.holdings) if (h.stable) idleByChain[h.chain] = Math.round(((idleByChain[h.chain] ?? 0) + h.amount) * 100) / 100;
  const idleUsd = Math.round(Object.values(idleByChain).reduce((a, v) => a + (v ?? 0), 0) * 100) / 100;

  const positions = req.source === "live"
    ? (await readAgentPositions(agent, s, req.scenario)).positions
    : projectPositions(req.legs, req.entry, s, req.scenario);
  const targets: Split = { ixs: 0, base: 0, rh_eth: 0, rh_stocks: 0 };
  for (const l of req.legs) targets[l.venue] = l.pct;

  const idleAtDeployUsd = req.entry.idleUsd ?? idleUsd;
  const trig = runTriggers({
    positions, targets, profile: req.profile,
    baseApyPct: s.base.netApyPct, ixsYieldPct: s.ixs.estYieldPct,
    ixs: { paused: s.ixs.paused, whitelistEnabled: s.ixs.whitelistEnabled, agentWhitelisted: s.ixs.agentWhitelisted, navFresh: s.ixs.navFresh },
    idleNowUsd: idleUsd, idleAtDeployUsd,
  });
  return { source: req.source, positions, targets, triggers: trig, idleUsd, idleAtDeployUsd, idleByChain, signals: s, scenario: req.scenario, at: new Date().toISOString() };
}
