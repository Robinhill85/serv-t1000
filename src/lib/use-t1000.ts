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
import type { Address } from "viem";
import type { WalletStepPrepare, WalletStepsResponse } from "@/app/api/wallet-steps/route";
import { wagmiConfig } from "@/components/WalletProvider";
import { confirm, runWalletSteps } from "./wallet-exec";

export type StepView = { key?: string; venue: string; chain: string; label: string; ok?: boolean; detail?: string; hash?: string; explorer?: string };
/** What a stopped wallet run needs to finish: its request, the steps confirmed onchain, and every transaction sent. */
export type WalletRequest = { kind: "plan" | "moves" | "withdraw"; address: string; [k: string]: unknown };
export type WalletResume = { request: WalletRequest; done: string[]; sent: { key: string; label: string; hash: string; chainId: number }[] };
/** by: "wallet" = signed in the user's own wallet ("My wallet" mode); otherwise the server/agent path. */
export type Execution = {
  mode: "simulate" | "live"; status: "running" | "done" | "failed"; checks: string[]; steps: StepView[]; error?: string; by?: "agent" | "wallet";
  /** Wallet runs that stopped part-way: "Finish the remaining steps" continues from here. */
  resume?: WalletResume;
  /** Server notes, e.g. a position that can't be withdrawn yet. */
  notes?: string[];
};
/** A withdrawal from the user's own wallet positions (Guard or a returning visitor's scan). */
export type ExitView = { venues: VenueId[]; moves: Move[]; from: Position[]; address: string; execution: Execution };
export type WalletTarget = "run" | "moves" | "exit";

export type ScanResult = { holdings: Holding[]; idleStablesUsd: number; maxRunUsd: number; walletMaxRunUsd: number; walletEnabled: boolean };

export type Phase = "idle" | "scanning_wallet" | "profile" | "targeting" | "deciding" | "verifying" | "done" | "guard" | "error";

export type GuardSource = "simulated" | "live";
export type GuardSession = {
  source: GuardSource;
  profile: Profile;
  /** pct = the plan's target weight; usd = the leg's value at entry (re-based after feeds and simulated moves). */
  legs: Leg[];
  entry: { at: number; ethPriceUsd: number | null; idleUsd: number | null };
  scenario: { ethMult: number } | null;
  /** True once real funds were deployed: the session is kept in this browser to resume later. */
  deployedLive: boolean;
  /** "My wallet" sessions: the user's wallet, read onchain when the source is "live" (else the operator's agent). */
  address?: string;
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
  plan: { split: Split; legs: Leg[]; adjustments: string[]; verified: boolean; blocked: string[]; iat?: number; planToken?: string } | null;
  profile: Profile | null;
  execution: Execution | null;
  error: string | null;
  startedAt: number | null;
  /** Client arrival times, used to pace the HUD animation. */
  arrived: { signals?: number; fast?: number };
  guard: GuardView | null;
  /** "My wallet" mode: the connected wallet this run plans for and signs with; null = demo. */
  wallet: string | null;
  walletMaxRunUsd: number | null;
  /** The connected wallet's T1000 positions, read onchain after a scan (returning visitors can withdraw). */
  positions: { address: string; list: Position[]; at: number } | null;
  exit: ExitView | null;
};

const initial: RunState = {
  phase: "idle", holdings: null, idleStablesUsd: null, maxRunUsd: null, signals: null, eligibility: null, jev: null,
  fast: null, verified: null, plan: null, error: null, startedAt: null, arrived: {}, profile: null, execution: null, guard: null,
  wallet: null, walletMaxRunUsd: null, positions: null, exit: null,
};
const clearedRun = { signals: null, eligibility: null, jev: null, fast: null, verified: null, plan: null, execution: null, error: null, arrived: {} };

export const GUARD_SCAN_MS = 60_000;
export const GUARD_STORE_KEY = "t1000.guard.v1";

function guardRequest(s: GuardSession) {
  const { preference, risk, horizon, instantAccess } = s.profile;
  // The user's wallet is only read for its real positions; projections stay on the demo path.
  const address = s.address && s.source === "live" ? { address: s.address } : {};
  return { source: s.source, profile: { preference, risk, horizon, instantAccess }, legs: s.legs, entry: s.entry, scenario: s.scenario, ...address };
}
const storeKey = (address?: string) => (address ? `${GUARD_STORE_KEY}.${address.toLowerCase()}` : GUARD_STORE_KEY);

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

/** Wallet-run failures go to the server log too (no personal data; the server strips addresses and hashes). */
function logWalletFailure(where: string, v: { venue?: string; chain?: string; label?: string; detail?: string }) {
  try {
    void fetch("/api/client-log", {
      method: "POST", keepalive: true, headers: { "content-type": "application/json" },
      body: JSON.stringify({ where, venue: v.venue, chain: v.chain, label: v.label?.slice(0, 160), detail: (v.detail ?? "no detail").slice(0, 600) }),
    }).catch(() => {});
  } catch { /* logging never breaks a run */ }
}

async function stepsApi<T>(body: object): Promise<T> {
  const res = await fetch("/api/wallet-steps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}

/**
 * One wallet run (a plan, Guard moves or a withdrawal): pre-flight from the wallet, then every step re-checked and
 * signed in turn. `prior` continues a stopped run: its confirmed steps stay confirmed and are never sent again.
 */
async function walletRun(
  mode: "simulate" | "live", request: WalletRequest, patch: (f: (ex: Execution) => Execution) => void,
  prior?: { resume: WalletResume; kept: StepView[] },
): Promise<boolean> {
  const done = [...(prior?.resume.done ?? [])];
  const sent = [...(prior?.resume.sent ?? [])];
  const kept = prior?.kept ?? [];
  const snapshot = (): WalletResume => ({ request, done: [...done], sent: [...sent] });
  const json = await stepsApi<WalletStepsResponse>({ ...request, skip: done });
  const preflight: StepView[] = json.simulation.map((r) => ({ venue: r.venue, chain: r.chain, label: r.label, ok: r.ok, detail: r.detail }));
  if (!json.ok) {
    for (const e of json.errors) logWalletFailure(`${request.kind}:preflight`, { detail: e });
    patch((ex) => ({
      ...ex, status: "failed", checks: json.errors, steps: [...kept, ...preflight], notes: json.notes,
      error: "Nothing was sent: the pre-flight check from your wallet did not pass.", resume: prior ? snapshot() : undefined,
    }));
    return false;
  }
  if (mode === "simulate") { patch((ex) => ({ ...ex, status: "done", steps: preflight, notes: json.notes })); return true; }
  if (!json.steps.length) { patch((ex) => ({ ...ex, status: "done", steps: kept, notes: json.notes, resume: undefined })); return true; }
  patch((ex) => ({ ...ex, notes: json.notes, steps: [...kept, ...json.steps.map((st) => ({ key: st.key, venue: st.venue, chain: st.chain, label: st.label, detail: "Waiting" }))] }));
  const ok = await runWalletSteps(
    wagmiConfig, json.steps, request.address as Address,
    (i, v) => {
      patch((ex) => ({ ...ex, steps: ex.steps.map((st, k) => (k === kept.length + i ? v : st)) }));
      if (v.ok === false) logWalletFailure(request.kind, v);
    },
    {
      prepare: (key) => stepsApi<WalletStepPrepare>({ ...request, skip: done, only: key }),
      sent: (st, hash) => { sent.push({ key: st.key, label: st.label, hash, chainId: st.chainId }); },
      confirmed: (key) => { done.push(key); },
    },
  );
  patch((ex) => ({ ...ex, status: ok ? "done" : "failed", resume: ok ? undefined : snapshot() }));
  return ok;
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

  /** Writes into one wallet run's execution view; a no-op once Restart has begun a new session. */
  const writerFor = useCallback((target: WalletTarget) => {
    const ep = epoch.current;
    return (f: (ex: Execution) => Execution) => {
      if (epoch.current !== ep) return;
      setState((s) => {
        if (target === "run") return s.execution ? { ...s, execution: f(s.execution) } : s;
        if (target === "moves") return s.guard?.moves ? { ...s, guard: { ...s.guard, moves: f(s.guard.moves) } } : s;
        return s.exit ? { ...s, exit: { ...s.exit, execution: f(s.exit.execution) } } : s;
      });
    };
  }, []);

  /** walletMode: the address is the user's connected wallet ("My wallet" mode); otherwise a demo scan. */
  const scanWallet = useCallback(async (address: string, walletMode = false) => {
    setState({ ...initial, phase: "scanning_wallet", wallet: walletMode ? address : null });
    try {
      const res = await fetch(`/api/scan?address=${address}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Scan failed.");
      setState((s) => ({ ...s, phase: "profile", holdings: json.holdings, idleStablesUsd: json.idleStablesUsd, maxRunUsd: json.maxRunUsd ?? null, walletMaxRunUsd: json.walletMaxRunUsd ?? null }));
      return json as ScanResult;
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
        body: JSON.stringify(stateRef.current.wallet ? { ...profile, wallet: stateRef.current.wallet } : profile),
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
              return { ...s, plan: { split: e.split, legs: e.legs, adjustments: e.adjustments, verified: e.verified, blocked: e.blocked ?? [], iat: signed.iat, planToken: signed.planToken }, phase: "done" };
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

  /**
   * "My wallet" mode. The server re-checks the signed plan against the wallet's live funds, builds its transactions and
   * pre-flight-simulates them from the wallet. "simulate" stops there; "live" then asks the wallet to confirm each one.
   */
  const executeWithWallet = useCallback(async (mode: "simulate" | "live", plan: RunState["plan"], profile: Profile | null) => {
    const address = stateRef.current.wallet;
    if (!plan?.planToken || !profile || !address) return;
    setState((s) => ({ ...s, execution: { mode, by: "wallet", status: "running", checks: [], steps: [] } }));
    const patch = writerFor("run");
    try {
      await walletRun(mode, { kind: "plan", address, profile, legs: plan.legs, iat: plan.iat, planToken: plan.planToken }, patch);
    } catch (e) {
      patch((ex) => ({ ...ex, status: "failed", error: e instanceof Error ? e.message : "The wallet run stopped." }));
    }
  }, [writerFor]);

  /** A returning visitor's positions, read onchain for their connected wallet. */
  const loadPositions = useCallback(async (address: string): Promise<Position[] | null> => {
    const ep = epoch.current;
    try {
      const res = await fetch(`/api/positions?address=${address}`);
      const json = await res.json();
      if (!res.ok) return null;
      if (epoch.current === ep) setState((s) => ({ ...s, positions: { address, list: json.positions as Position[], at: json.at as number } }));
      return json.positions as Position[];
    } catch {
      return null;
    }
  }, []);

  /**
   * Continues a stopped wallet run. Transactions that were sent but never confirmed are looked up first: confirmed
   * ones count as done, reverted ones are rebuilt, and one still unknown stops here so nothing is ever sent twice.
   */
  const resumeWallet = useCallback(async (target: WalletTarget) => {
    const s = stateRef.current;
    const ex = target === "run" ? s.execution : target === "moves" ? s.guard?.moves : s.exit?.execution;
    const r = ex?.resume;
    if (!ex || !r) return;
    const patch = writerFor(target);
    patch((x) => ({ ...x, status: "running", error: undefined, checks: [] }));
    const done = [...r.done];
    try {
      for (const t of r.sent.filter((x) => !done.includes(x.key))) {
        const rc = await confirm(wagmiConfig, t.hash as `0x${string}`, t.chainId, 20_000).catch(() => null);
        if (rc?.status === "success") {
          done.push(t.key);
          patch((x) => ({ ...x, steps: x.steps.map((st) => (st.key === t.key ? { ...st, ok: true, detail: "Confirmed" } : st)) }));
        } else if (!rc) {
          patch((x) => ({ ...x, status: "failed", error: `"${t.label}" was sent but hasn't confirmed yet. Check its tx link and try again in a minute. Nothing else was sent.` }));
          return;
        }
      }
      const kept = ex.steps.filter((st) => st.key && done.includes(st.key)).map((st) => (st.ok ? st : { ...st, ok: true, detail: "Confirmed" }));
      await walletRun("live", r.request, patch, { resume: { ...r, done }, kept });
    } catch (e) {
      patch((x) => ({ ...x, status: "failed", error: e instanceof Error ? e.message : "The wallet run stopped." }));
    }
  }, [writerFor]);

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
    const byWallet = s.execution.by === "wallet" && !!s.wallet;
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
        address: base.address ?? (byWallet ? s.wallet! : undefined),
      };
    } else {
      session = {
        source: mode === "live" ? "live" : "simulated",
        profile: s.profile,
        legs: s.plan.legs,
        entry: { at: Date.now(), ethPriceUsd: s.signals?.rhEth.priceUsd ?? null, idleUsd: null },
        scenario: null,
        deployedLive: mode === "live",
        address: byWallet ? s.wallet! : undefined,
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
    if (g.session.address && g.session.source === "live") {
      // Moves on the user's own wallet: same server checks, signed in their wallet.
      const address = g.session.address;
      write((x) => ({ ...x, moves: { ...blank, by: "wallet" } }));
      try {
        await walletRun(mode, { kind: "moves", address, moves: plan.check.executable, guard: guardRequest(g.session), iat: plan.iat, planToken: plan.planToken }, writerFor("moves"));
      } catch (e) {
        fail(e instanceof Error ? e.message : "The wallet run stopped.");
      }
      return;
    }
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
  }, [guardWriter, writerFor]);

  /**
   * Withdraw: full exits from the chosen venues back to the user's own wallet, signed there. Works from Guard (a wallet
   * session on live positions) and for a returning visitor after a scan. The scene drains those vaults as it runs.
   */
  const withdraw = useCallback(async (venues: VenueId[]) => {
    const s = stateRef.current;
    const g = s.guard;
    const inGuard = !!g && g.session.source === "live" && !!g.session.address;
    const address = inGuard ? g!.session.address! : s.positions?.address;
    if (!address) return;
    const from = (inGuard ? g!.data?.positions : s.positions?.list) ?? [];
    const moves: Move[] = from.filter((p) => venues.includes(p.venue) && p.usd > 0)
      .map((p) => ({ from: p.venue, to: "idle", usd: p.usd, bridge_required: false, why: "Withdraw to your wallet" }));
    setState((x) => ({ ...x, exit: { venues, moves, from, address, execution: { mode: "live", by: "wallet", status: "running", checks: [], steps: [] } } }));
    const patch = writerFor("exit");
    try {
      await walletRun("live", { kind: "withdraw", address, venues }, patch);
    } catch (e) {
      patch((ex) => ({ ...ex, status: "failed", error: e instanceof Error ? e.message : "The withdrawal stopped." }));
    }
  }, [writerFor]);

  /** Closes a withdrawal and re-reads the positions (Guard re-scans; otherwise the wallet's positions reload). */
  const finishExit = useCallback(() => {
    const s = stateRef.current;
    const address = s.exit?.address;
    setState((x) => ({ ...x, exit: null }));
    if (s.guard) void scanGuard();
    else if (address) void loadPositions(address);
  }, [scanGuard, loadPositions]);

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

  /** A live deployment's Guard session is kept in this browser (the operator's, or per connected wallet) to resume. */
  const resumeGuard = useCallback((address?: string) => {
    let session: GuardSession | null = null;
    try { session = JSON.parse(localStorage.getItem(storeKey(address)) ?? "null"); } catch { session = null; }
    if (!session?.legs?.length || !session.profile) return;
    session = { ...session, source: "live", scenario: null, address: address ?? session.address };
    setState({
      ...initial, phase: "guard", profile: session.profile, wallet: address ?? null,
      guard: { session, data: null, scanning: false, error: null, lastScanAt: null, feeding: null, rebalance: null, moves: null, movesFrom: null },
    });
    void scanGuard(session);
  }, [scanGuard]);

  const session = state.guard?.session;
  useEffect(() => {
    if (!session?.deployedLive) return;
    try { localStorage.setItem(storeKey(session.address), JSON.stringify(session)); } catch { /* storage unavailable */ }
  }, [session]);

  // Auto re-scan every minute while Guard is simply watching (paused during a feed, a proposal or moves).
  const g = state.guard;
  const watching = !!g && g.feeding == null && !g.rebalance && !g.moves && !g.scanning && !state.exit;
  const lastScanAt = g?.lastScanAt ?? null;
  useEffect(() => {
    if (!watching || lastScanAt == null) return;
    const id = setTimeout(() => { void scanGuard(); }, Math.max(0, lastScanAt + GUARD_SCAN_MS - Date.now()));
    return () => clearTimeout(id);
  }, [watching, lastScanAt, scanGuard]);

  const reset = useCallback(() => { abortRef.current?.abort(); scanSeq.current++; epoch.current++; setState(initial); }, []);
  return {
    state, scanWallet, run, reset, executePlan, executeWithWallet, loadPositions, resumeWallet, withdraw, finishExit,
    enterGuard, scanGuard, setGuardSource, setScenario, feed, cancelFeed, proposeRebalance, executeMoves, applyMoves, dismissRebalance, resumeGuard,
  };
}
