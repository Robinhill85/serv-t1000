"use client";
// Client state for a T1000 session: wallet scan, the streamed decision pipeline, execution, and Guard mode
// (positions, code triggers, SERV rebalances, feeding new cash). The HUD, the vault scene and the chat all read this.
import { useCallback, useEffect, useRef, useState } from "react";
import type { VenueId } from "./config";
import type { DecideResult, ServResult } from "./decide";
import type { GuardState } from "./guard";
import type { JevResult } from "./jev";
import type { PipelineEvent } from "./pipeline";
import type { MoveCheck } from "./plan-guard";
import type { Move, RebalanceDecision } from "./rebalance";
import type { Holding } from "./scan";
import type { Signals } from "./signals";
import { blendTargets, rebase } from "./guard-math";
import type { Eligibility, Leg, Position, Profile, Split } from "./types";

export type StepView = { venue: string; chain: string; label: string; ok?: boolean; detail?: string; hash?: string; explorer?: string };
export type Execution = { mode: "simulate" | "live"; status: "running" | "done" | "failed"; checks: string[]; steps: StepView[]; error?: string };

export type Phase = "idle" | "scanning_wallet" | "profile" | "targeting" | "deciding" | "verifying" | "done" | "guard" | "error";

export type GuardSource = "simulated" | "live";
export type GuardSession = {
  source: GuardSource;
  profile: Profile;
  /** pct = the plan's target weight; usd = the leg's value at entry (re-based after feeds and simulated moves). */
  legs: Leg[];
  entry: { at: number; ethPriceUsd: number | null; idleUsd: number | null };
  scenario: { ethMult: number } | null;
  /** True once real funds were deployed: the session is kept in this browser (the operator's) to resume later. */
  deployedLive: boolean;
};
export type MovePlan = { summary: string; moves: Move[]; check: MoveCheck; verified: boolean; iat?: number; planToken?: string };
export type RebalanceView = {
  status: "running" | "done" | "error";
  fast?: ServResult<RebalanceDecision>;
  verified?: ServResult<RebalanceDecision>;
  plan?: MovePlan;
  error?: string;
};
export type GuardView = {
  session: GuardSession;
  data: GuardState | null;
  scanning: boolean;
  error: string | null;
  lastScanAt: number | null;
  /** Amount being fed through the normal pipeline; the regular HUD shows while it runs. */
  feeding: number | null;
  rebalance: RebalanceView | null;
  moves: Execution | null;
  /** Positions when the moves started: the vault scene's starting levels. */
  movesFrom: Position[] | null;
};

export type RunState = {
  phase: Phase;
  holdings: Holding[] | null;
  idleStablesUsd: number | null;
  maxRunUsd: number | null;
  signals: Signals | null;
  eligibility: Record<VenueId, Eligibility> | null;
  jev: JevResult | null;
  fast: { result: DecideResult; split: Split | null; legs: Leg[] } | null;
  verified: { result: DecideResult; revised: boolean } | null;
  plan: { split: Split; legs: Leg[]; adjustments: string[]; verified: boolean; iat?: number; planToken?: string } | null;
  profile: Profile | null;
  execution: Execution | null;
  error: string | null;
  startedAt: number | null;
  /** Client arrival times, used to pace the HUD animation. */
  arrived: { signals?: number; fast?: number };
  guard: GuardView | null;
};

const initial: RunState = {
  phase: "idle", holdings: null, idleStablesUsd: null, maxRunUsd: null, signals: null, eligibility: null, jev: null,
  fast: null, verified: null, plan: null, error: null, startedAt: null, arrived: {}, profile: null, execution: null, guard: null,
};
const clearedRun = { signals: null, eligibility: null, jev: null, fast: null, verified: null, plan: null, execution: null, error: null, arrived: {} };

export const GUARD_SCAN_MS = 60_000;
export const GUARD_STORE_KEY = "t1000.guard.v1";

function guardRequest(s: GuardSession) {
  const { preference, risk, horizon, instantAccess } = s.profile;
  return { source: s.source, profile: { preference, risk, horizon, instantAccess }, legs: s.legs, entry: s.entry, scenario: s.scenario };
}

/** Reads a `data: {...}\n\n` event stream to the end. */
async function readSse(res: Response, on: (e: { type: string; [k: string]: unknown }) => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (chunk.startsWith("data: ")) on(JSON.parse(chunk.slice(6)));
    }
  }
}

/** One /api/execute event applied to an execution view (plans and moves stream the same events). */
function applyExec(ex: Execution, e: { type: string; [k: string]: unknown }): Execution {
  switch (e.type) {
    case "checks": return { ...ex, checks: e.errors as string[] };
    case "steps": return { ...ex, steps: e.steps as StepView[] };
    case "step": {
      const r = e.result as StepView;
      return { ...ex, steps: ex.steps.map((st) => (st.label === r.label && st.ok === undefined ? { ...st, ...r } : st)) };
    }
    case "done": return { ...ex, status: e.ok ? "done" : "failed" };
    case "error": return { ...ex, status: "failed", error: e.message as string };
    default: return ex;
  }
}

export function useT1000() {
  const [state, setState] = useState<RunState>(initial);
  const abortRef = useRef<AbortController | null>(null);
  const scanSeq = useRef(0);
  // Bumped by reset: streams still running from before a restart stop writing into the new session.
  const epoch = useRef(0);
  // Actions read the latest committed state from here (they run from handlers and timers, never during render).
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const setGuard = useCallback((f: (g: GuardView) => GuardView) => setState((s) => (s.guard ? { ...s, guard: f(s.guard) } : s)), []);
  /** setGuard for async work started in one session: a no-op once Restart has begun a new one. */
  const guardWriter = useCallback(() => {
    const ep = epoch.current;
    return (f: (g: GuardView) => GuardView) => { if (epoch.current === ep) setGuard(f); };
  }, [setGuard]);

  const scanWallet = useCallback(async (address: string) => {
    setState({ ...initial, phase: "scanning_wallet" });
    try {
      const res = await fetch(`/api/scan?address=${address}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Scan failed.");
      setState((s) => ({ ...s, phase: "profile", holdings: json.holdings, idleStablesUsd: json.idleStablesUsd, maxRunUsd: json.maxRunUsd ?? null }));
      return json.idleStablesUsd as number;
    } catch (e) {
      setState((s) => ({ ...s, phase: "error", error: e instanceof Error ? e.message : "Scan failed." }));
      return null;
    }
  }, []);

  const run = useCallback(async (profile: Profile) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState((s) => ({ ...s, ...clearedRun, phase: "targeting", startedAt: Date.now(), profile }));
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profile),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? "Decision failed.");
      await readSse(res, (raw) => {
        const e = raw as unknown as PipelineEvent | { type: "done" };
        setState((s) => {
          switch (e.type) {
            case "signals": return { ...s, signals: e.signals, arrived: { ...s.arrived, signals: Date.now() } };
            case "eligibility": return { ...s, eligibility: e.eligibility, phase: "deciding" };
            case "jev": return { ...s, jev: e.jev };
            case "decision_fast": return { ...s, fast: { result: e.result, split: e.split, legs: e.legs }, phase: "verifying", arrived: { ...s.arrived, fast: Date.now() } };
            case "decision_verified": return { ...s, verified: { result: e.result, revised: e.revised } };
            case "plan": {
              const signed = e as typeof e & { iat?: number; planToken?: string };
              return { ...s, plan: { split: e.split, legs: e.legs, adjustments: e.adjustments, verified: e.verified, iat: signed.iat, planToken: signed.planToken }, phase: "done" };
            }
            case "error": return { ...s, phase: "error", error: e.message };
            default: return s;
          }
        });
      });
    } catch (e) {
      if (!ctrl.signal.aborted) setState((s) => ({ ...s, phase: "error", error: e instanceof Error ? e.message : "Decision failed." }));
    }
  }, []);

  /** Runs the signed plan: "simulate" for anyone (nothing is sent), "live" with the operator passcode. */
  const executePlan = useCallback(async (mode: "simulate" | "live", plan: RunState["plan"], profile: Profile | null, passcode?: string) => {
    if (!plan?.planToken || !profile) return;
    const ep = epoch.current;
    const blank: Execution = { mode, status: "running", checks: [], steps: [] };
    setState((s) => ({ ...s, execution: blank }));
    const fail = (error: string) => { if (epoch.current === ep) setState((s) => ({ ...s, execution: { ...(s.execution ?? blank), status: "failed", error } })); };
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, profile, legs: plan.legs, iat: plan.iat, planToken: plan.planToken, passcode }),
      });
      if (!res.ok || !res.body) { fail((await res.json().catch(() => ({}))).error ?? "Execution failed."); return; }
      await readSse(res, (e) => { if (epoch.current === ep) setState((s) => ({ ...s, execution: applyExec(s.execution ?? blank, e) })); });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Execution failed.");
    }
  }, []);

  // ---------- Guard mode ----------

  /** Re-reads positions and triggers. A newer scan always wins over an older one still in flight. */
  const scanGuard = useCallback(async (sessionArg?: GuardSession) => {
    const session = sessionArg ?? stateRef.current.guard?.session;
    if (!session) return;
    const seq = ++scanSeq.current;
    setGuard((g) => ({ ...g, scanning: true, error: null }));
    try {
      const res = await fetch("/api/guard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(guardRequest(session)) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Guard scan failed.");
      if (seq !== scanSeq.current) return;
      const data = json as GuardState;
      setGuard((g) => {
        // The first scan after a deploy or a feed sets the NEW_CASH baseline.
        const s = g.session.entry.idleUsd == null ? { ...g.session, entry: { ...g.session.entry, idleUsd: data.idleAtDeployUsd } } : g.session;
        return { ...g, session: s, data, scanning: false, lastScanAt: Date.now() };
      });
    } catch (e) {
      if (seq !== scanSeq.current) return;
      setGuard((g) => ({ ...g, scanning: false, error: e instanceof Error ? e.message : "Guard scan failed.", lastScanAt: Date.now() }));
    }
  }, [setGuard]);

  /** After a deploy (or a feed) completes: the plan becomes positions and the vision switches to Guard. */
  const enterGuard = useCallback(() => {
    const s = stateRef.current;
    if (!s.plan || !s.profile || !s.execution) return;
    const mode = s.execution.mode;
    const prev = s.guard;
    let session: GuardSession;
    if (prev && prev.feeding != null) {
      const base = prev.session;
      const held = prev.data?.positions.reduce((a, p) => a + p.usd, 0) ?? 0;
      const fed = Object.fromEntries(s.plan.legs.map((l) => [l.venue, l.usd])) as Partial<Record<VenueId, number>>;
      const targets = blendTargets(base.legs, held, s.plan.legs);
      const legs = base.source === "simulated" && prev.data
        ? rebase(base, prev.data, fed)
        : [...new Set([...base.legs.map((l) => l.venue), ...s.plan.legs.map((l) => l.venue)])].map((v) => ({
          venue: v, pct: 0, usd: (base.legs.find((l) => l.venue === v)?.usd ?? 0) + (fed[v] ?? 0),
        }));
      session = {
        ...base,
        legs: legs.map((l) => ({ ...l, pct: targets[l.venue] ?? 0 })),
        entry: { ...base.entry, idleUsd: null },
        deployedLive: base.deployedLive || mode === "live",
      };
    } else {
      session = {
        source: mode === "live" ? "live" : "simulated",
        profile: s.profile,
        legs: s.plan.legs,
        entry: { at: Date.now(), ethPriceUsd: s.signals?.rhEth.priceUsd ?? null, idleUsd: null },
        scenario: null,
        deployedLive: mode === "live",
      };
    }
    setState((x) => ({
      ...x, ...clearedRun, phase: "guard",
      guard: { session, data: prev?.data ?? null, scanning: false, error: null, lastScanAt: null, feeding: null, rebalance: null, moves: null, movesFrom: null },
    }));
    void scanGuard(session);
  }, [scanGuard]);

  /** Switches source or scenario; any open proposal is dropped because it was made for the old view. */
  const updateSession = useCallback((patch: Partial<GuardSession>) => {
    const g = stateRef.current.guard;
    if (!g) return;
    const session = { ...g.session, ...patch };
    const sourceChanged = patch.source !== undefined && patch.source !== g.session.source;
    setGuard((x) => ({ ...x, session, data: sourceChanged ? null : x.data, rebalance: null, moves: null, movesFrom: null }));
    void scanGuard(session);
  }, [scanGuard, setGuard]);
  const setGuardSource = useCallback((source: GuardSource) => updateSession(source === "live" ? { source, scenario: null } : { source }), [updateSession]);
  const setScenario = useCallback((scenario: GuardSession["scenario"]) => updateSession({ scenario }), [updateSession]);

  /** NEW_CASH: the new idle stables go through the normal pipeline (scan, SERV draft + verify, simulate/live). */
  const feed = useCallback((amountUsd: number) => {
    const g = stateRef.current.guard;
    if (!g) return;
    setGuard((x) => ({ ...x, feeding: amountUsd, rebalance: null }));
    void run({ ...g.session.profile, amountUsd });
  }, [run, setGuard]);
  const cancelFeed = useCallback(() => {
    abortRef.current?.abort();
    setState((s) => (s.guard ? { ...s, ...clearedRun, phase: "guard", guard: { ...s.guard, feeding: null } } : s));
  }, []);

  /** Asks SERV for moves (fast draft, then verified), streamed with the code check and a signed move plan. */
  const proposeRebalance = useCallback(async () => {
    const g = stateRef.current.guard;
    if (!g) return;
    const write = guardWriter();
    write((x) => ({ ...x, rebalance: { status: "running" }, moves: null, movesFrom: null }));
    const fail = (error: string) => write((x) => ({ ...x, rebalance: { ...(x.rebalance ?? {}), status: "error", error } }));
    try {
      const res = await fetch("/api/rebalance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(guardRequest(g.session)) });
      if (!res.ok || !res.body) { fail((await res.json().catch(() => ({}))).error ?? "Rebalance failed."); return; }
      await readSse(res, (e) => write((x) => {
        const rb: RebalanceView = x.rebalance ?? { status: "running" };
        switch (e.type) {
          case "guard": return { ...x, data: e.guard as GuardState, lastScanAt: Date.now() };
          case "rebalance_fast": return { ...x, rebalance: { ...rb, fast: e.result as ServResult<RebalanceDecision> } };
          case "rebalance_verified": return { ...x, rebalance: { ...rb, verified: e.result as ServResult<RebalanceDecision> } };
          case "move_plan": {
            const { summary, moves, check, verified, iat, planToken } = e as unknown as MovePlan;
            return { ...x, rebalance: { ...rb, status: "done", plan: { summary, moves, check, verified, iat, planToken } } };
          }
          case "error": return { ...x, rebalance: { ...rb, status: "error", error: e.message as string } };
          default: return x;
        }
      }));
      write((x) => (x.rebalance?.status === "running" ? { ...x, rebalance: { ...x.rebalance, status: "error", error: "SERV returned no proposal." } } : x));
    } catch (e) {
      fail(e instanceof Error ? e.message : "Rebalance failed.");
    }
  }, [guardWriter]);

  /** Runs the signed moves: simulate for anyone; live only with the passcode, on real positions, never a scenario. */
  const executeMoves = useCallback(async (mode: "simulate" | "live", passcode?: string) => {
    const g = stateRef.current.guard;
    const plan = g?.rebalance?.plan;
    if (!g || !plan?.planToken) return;
    const write = guardWriter();
    const blank: Execution = { mode, status: "running", checks: [], steps: [] };
    write((x) => ({ ...x, moves: blank, movesFrom: x.data?.positions ?? null }));
    const fail = (error: string) => write((x) => ({ ...x, moves: { ...(x.moves ?? blank), status: "failed", error } }));
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "moves", mode, moves: plan.check.executable, guard: guardRequest(g.session), iat: plan.iat, planToken: plan.planToken, passcode }),
      });
      if (!res.ok || !res.body) { fail((await res.json().catch(() => ({}))).error ?? "Execution failed."); return; }
      await readSse(res, (e) => write((x) => ({ ...x, moves: applyExec(x.moves ?? blank, e) })));
    } catch (e) {
      fail(e instanceof Error ? e.message : "Execution failed.");
    }
  }, [guardWriter]);

  /** After the moves finish: simulated positions take the moves on board; live positions are simply re-read. */
  const applyMoves = useCallback(() => {
    const g = stateRef.current.guard;
    if (!g) return;
    const plan = g.rebalance?.plan;
    let session = g.session;
    if (g.moves?.status === "done" && plan && g.data && session.source === "simulated") {
      const delta: Partial<Record<VenueId, number>> = {};
      for (const m of plan.check.executable) {
        if (m.from !== "idle") delta[m.from] = (delta[m.from] ?? 0) - m.usd;
        if (m.to !== "idle") delta[m.to] = (delta[m.to] ?? 0) + m.usd;
      }
      session = { ...session, legs: rebase(session, g.data, delta) };
    }
    setGuard((x) => ({ ...x, session, rebalance: null, moves: null, movesFrom: null }));
    void scanGuard(session);
  }, [scanGuard, setGuard]);

  const dismissRebalance = useCallback(() => setGuard((x) => ({ ...x, rebalance: null, moves: null, movesFrom: null })), [setGuard]);

  /** The operator's browser keeps a live deployment's Guard session, so it can be resumed on a later visit. */
  const resumeGuard = useCallback(() => {
    let session: GuardSession | null = null;
    try { session = JSON.parse(localStorage.getItem(GUARD_STORE_KEY) ?? "null"); } catch { session = null; }
    if (!session?.legs?.length || !session.profile) return;
    session = { ...session, source: "live", scenario: null };
    setState({ ...initial, phase: "guard", profile: session.profile, guard: { session, data: null, scanning: false, error: null, lastScanAt: null, feeding: null, rebalance: null, moves: null, movesFrom: null } });
    void scanGuard(session);
  }, [scanGuard]);

  const session = state.guard?.session;
  useEffect(() => {
    if (!session?.deployedLive) return;
    try { localStorage.setItem(GUARD_STORE_KEY, JSON.stringify(session)); } catch { /* storage unavailable */ }
  }, [session]);

  // Auto re-scan every minute while Guard is simply watching (paused during a feed, a proposal or moves).
  const g = state.guard;
  const watching = !!g && g.feeding == null && !g.rebalance && !g.moves && !g.scanning;
  const lastScanAt = g?.lastScanAt ?? null;
  useEffect(() => {
    if (!watching || lastScanAt == null) return;
    const id = setTimeout(() => { void scanGuard(); }, Math.max(0, lastScanAt + GUARD_SCAN_MS - Date.now()));
    return () => clearTimeout(id);
  }, [watching, lastScanAt, scanGuard]);

  const reset = useCallback(() => { abortRef.current?.abort(); scanSeq.current++; epoch.current++; setState(initial); }, []);
  return {
    state, scanWallet, run, reset, executePlan,
    enterGuard, scanGuard, setGuardSource, setScenario, feed, cancelFeed, proposeRebalance, executeMoves, applyMoves, dismissRebalance, resumeGuard,
  };
}
