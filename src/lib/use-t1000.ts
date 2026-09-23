"use client";
// Client state for one T1000 run: wallet scan + streamed pipeline events. The HUD and chat both read from this.
import { useCallback, useRef, useState } from "react";
import type { VenueId } from "./config";
import type { DecideResult } from "./decide";
import type { JevResult } from "./jev";
import type { PipelineEvent } from "./pipeline";
import type { Holding } from "./scan";
import type { Signals } from "./signals";
import type { Eligibility, Leg, Profile, Split } from "./types";

export type StepView = { venue: string; chain: string; label: string; ok?: boolean; detail?: string; hash?: string; explorer?: string };
export type Execution = { mode: "simulate" | "live"; status: "running" | "done" | "failed"; checks: string[]; steps: StepView[]; error?: string };

export type Phase = "idle" | "scanning_wallet" | "profile" | "targeting" | "deciding" | "verifying" | "done" | "error";

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
};

const initial: RunState = {
  phase: "idle", holdings: null, idleStablesUsd: null, maxRunUsd: null, signals: null, eligibility: null, jev: null,
  fast: null, verified: null, plan: null, error: null, startedAt: null, arrived: {}, profile: null, execution: null,
};

export function useT1000() {
  const [state, setState] = useState<RunState>(initial);
  const abortRef = useRef<AbortController | null>(null);

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
    setState((s) => ({ ...s, phase: "targeting", signals: null, eligibility: null, jev: null, fast: null, verified: null, plan: null, error: null, startedAt: Date.now(), arrived: {}, profile, execution: null }));
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profile),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? "Decision failed.");
      const reader = res.body.getReader();
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
          if (chunk.startsWith("data: ")) apply(JSON.parse(chunk.slice(6)) as PipelineEvent | { type: "done" });
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setState((s) => ({ ...s, phase: "error", error: e instanceof Error ? e.message : "Decision failed." }));
    }

    function apply(e: PipelineEvent | { type: "done" }) {
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
    }
  }, []);

  /** Runs the signed plan: "simulate" for anyone (nothing is sent), "live" with the operator passcode. */
  const executePlan = useCallback(async (mode: "simulate" | "live", plan: RunState["plan"], profile: Profile | null, passcode?: string) => {
    if (!plan?.planToken || !profile) return;
    setState((s) => ({ ...s, execution: { mode, status: "running", checks: [], steps: [] } }));
    const fail = (error: string) => setState((s) => ({ ...s, execution: { ...(s.execution ?? { mode, checks: [], steps: [] }), status: "failed", error } }));
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, profile, legs: plan.legs, iat: plan.iat, planToken: plan.planToken, passcode }),
      });
      if (!res.ok || !res.body) { fail((await res.json().catch(() => ({}))).error ?? "Execution failed."); return; }
      const reader = res.body.getReader();
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
          if (!chunk.startsWith("data: ")) continue;
          const e = JSON.parse(chunk.slice(6));
          setState((s) => {
            const ex = s.execution ?? { mode, status: "running" as const, checks: [], steps: [] };
            switch (e.type) {
              case "checks": return { ...s, execution: { ...ex, checks: e.errors } };
              case "steps": return { ...s, execution: { ...ex, steps: e.steps } };
              case "step": {
                const steps = ex.steps.map((st) => (st.label === e.result.label && st.ok === undefined ? { ...st, ...e.result } : st));
                return { ...s, execution: { ...ex, steps } };
              }
              case "done": return { ...s, execution: { ...ex, status: e.ok ? "done" : "failed" } };
              case "error": return { ...s, execution: { ...ex, status: "failed", error: e.message } };
              default: return s;
            }
          });
        }
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : "Execution failed.");
    }
  }, []);

  const reset = useCallback(() => { abortRef.current?.abort(); setState(initial); }, []);
  return { state, scanWallet, run, reset, executePlan };
}
