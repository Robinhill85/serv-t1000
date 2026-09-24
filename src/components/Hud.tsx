"use client";
// Infrared allocation vision. Original art in the spirit of a 90s machine HUD; no film footage or likeness.
import { useEffect, useMemo, useState } from "react";
import { VENUES, type VenueId } from "@/lib/config";
import type { JevScore } from "@/lib/jev";
import type { RunState } from "@/lib/use-t1000";

const ORDER: VenueId[] = ["base", "ixs", "rh_eth", "rh_stocks"];
const TARGET_X = [15, 38, 62, 85]; // % positions across the field

const usd = (n: number | null | undefined, d = 0) =>
  n == null ? "N/A" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const compactUsd = (n: number | null | undefined) =>
  n == null ? "N/A" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : usd(n);

function NoiseColumn({ rows = 6, seed = 0 }: { rows?: number; seed?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 180);
    return () => clearInterval(id);
  }, []);
  const lines = useMemo(() => {
    const r = (i: number) => Math.abs(Math.sin((tick + 1) * (i + 3) * (seed + 7.13)) * 1e5) | 0;
    return Array.from({ length: rows }, (_, i) => `${r(i) % 9000 + 1000} ${r(i + 9) % 90 + 10} ${r(i + 17) % 9000 + 1000}`);
  }, [tick, rows, seed]);
  return <div className="hud-noise">{lines.map((l, i) => <div key={i}>{l}</div>)}</div>;
}

function JevBar({ name, s }: { name: string; s?: JevScore }) {
  if (!s) return null;
  const pct = s.max > 0 ? Math.round((s.value / s.max) * 100) : 0;
  return (
    <div className="hud-jev">
      <span>{name}</span>
      <span className="hud-jev-track"><span style={{ width: `${pct}%` }} /></span>
      <span>{s.label.toUpperCase()}</span>
    </div>
  );
}

/** Two to four short lines per target: kept brief so they stay readable at stream size. */
function targetParams(id: VenueId, st: RunState): string[] {
  const s = st.signals;
  if (!s) return [];
  switch (id) {
    case "base":
      return [`APY ${s.base.netApyPct ?? "N/A"}%`, `TVL ${compactUsd(s.base.tvlUsd)}`, "EXIT INSTANT"];
    case "ixs":
      return [
        `YIELD ${s.ixs.estYieldPct}%`,
        `SETTLES ${s.ixs.settlement.includes("T+1") ? "T+1" : s.ixs.settlement}`,
        `MIN ${usd(s.ixs.minUsd)} · FEE ${s.ixs.exitFeeBps == null ? "N/A" : `${s.ixs.exitFeeBps / 100}%`}`,
        `WHITELIST ${s.ixs.whitelistEnabled ? "ON" : "OFF"}`,
      ];
    case "rh_eth":
      return [
        `ETH ${usd(s.rhEth.priceUsd)}`,
        `7D ${s.rhEth.change7dPct == null ? "N/A" : (s.rhEth.change7dPct > 0 ? "+" : "") + s.rhEth.change7dPct + "%"}`,
        `DEPTH ${compactUsd(s.rhEth.poolUsdgDepth)}`,
      ];
    case "rh_stocks":
      return [s.market.session.split(":")[0].toUpperCase(), s.market.weekend ? "ORACLES FROZEN" : "ORACLES 24/5"];
  }
}

function jevFor(id: VenueId, st: RunState) {
  const j = st.jev?.scores ?? {};
  switch (id) {
    case "base": return [["YIELD", j.base_stable_yield]] as const;
    case "ixs": return [["YIELD", j.ixs_rwa_yield]] as const;
    case "rh_eth": return [["RISK", j.rh_eth_entry_risk], ["PRICE OK", j.rh_pricing_reliable]] as const;
    case "rh_stocks": return [["PRICE OK", j.stock_pricing_reliable]] as const;
  }
}

export function Hud({ state }: { state: RunState }) {
  const { signals, eligibility, fast, verified, plan, phase } = state;

  // Animation clock: everything below is derived from arrival times, so no effect sets state synchronously.
  const [now, setNow] = useState(0);
  const animating = !!state.arrived.signals && phase !== "error";
  useEffect(() => {
    if (!animating) return;
    const id = setInterval(() => setNow(Date.now()), 90);
    return () => clearInterval(id);
  }, [animating]);

  // Scope sweeps the targets one by one (950ms each) once live data and eligibility are in.
  const SWEEP_MS = 950;
  const sweepStart = signals && eligibility ? state.arrived.signals ?? null : null;
  const lock = sweepStart == null || now === 0 ? -1 : Math.min(ORDER.length, Math.floor(Math.max(0, now - sweepStart) / SWEEP_MS));
  const sweepDone = lock >= ORDER.length;

  // Candidate cursor: sweeps down the whole list once, then steps back up to the chosen option (280ms a step).
  const decision = fast?.result.decision ?? null;
  const chosenIdx = decision ? Math.max(0, decision.candidates.findIndex((c) => c.id === decision.chosen_id)) : -1;
  const seq = useMemo(() => {
    if (!decision) return [] as number[];
    const n = decision.candidates.length;
    const out = Array.from({ length: n }, (_, k) => k);
    for (let k = n - 2; k >= chosenIdx; k--) out.push(k);
    return out;
  }, [decision, chosenIdx]);
  const listStart = decision && sweepStart != null && state.arrived.fast != null
    ? Math.max(state.arrived.fast, sweepStart + ORDER.length * SWEEP_MS)
    : null;
  const cursor = listStart == null || now < listStart || !seq.length ? -1 : seq[Math.min(seq.length - 1, Math.floor((now - listStart) / 280))];
  const settled = cursor === chosenIdx && cursor >= 0;

  const reticle = { left: `${TARGET_X[lock >= 0 && lock < ORDER.length ? lock : 0]}%` };

  const legs = settled ? (plan?.legs ?? fast?.legs ?? []) : [];
  const showList = sweepDone && decision;
  const stateLabel =
    phase === "idle" ? "STANDBY" : phase === "scanning_wallet" ? "SCANNING WALLET" : phase === "profile" ? "AWAITING PARAMETERS"
      : !sweepDone ? "TARGET ACQUISITION" : !decision ? "SERV MULTIPATH REASONING" : !verified ? "SHADOW AGENT VERIFYING"
        : phase === "done" ? "ALLOCATION LOCKED" : phase === "error" ? "FAULT" : "PROCESSING";

  const log = useMemo(() => {
    const out: string[] = [];
    if (state.idleStablesUsd != null) out.push(`WALLET SCAN ${usd(state.idleStablesUsd, 2)} IDLE STABLES`);
    if (signals) out.push(`SIGNALS LIVE ${new Date(signals.at).toISOString().slice(11, 19)}Z`);
    if (state.jev) out.push(`JEV ${state.jev.status} ${Object.keys(state.jev.scores).length} SCORES ${state.jev.ms}MS`);
    if (fast) out.push(`SERV MULTIPATH DRAFT ${(fast.result.ms / 1000).toFixed(1)}S`);
    if (verified) out.push(`SHADOW AGENT ${verified.revised ? "CORRECTED" : "PASSED"} ${(verified.result.ms / 1000).toFixed(1)}S`);
    for (const a of plan?.adjustments ?? []) out.push(`GUARD ${a.toUpperCase()}`);
    if (state.error) out.push(`FAULT ${state.error.toUpperCase()}`);
    return out.slice(-6);
  }, [state.idleStablesUsd, signals, state.jev, fast, verified, plan, state.error]);

  return (
    <div className={`hud ${showList ? "is-listing" : ""}`}>
      <div className="hud-heat" aria-hidden />
      <div className="hud-horizon" aria-hidden />

      <header className="hud-top">
        <div>
          <div className="hud-title">T1000 // ALLOCATION VISION</div>
          <div className="hud-sub">MODE: {stateLabel}</div>
        </div>
        <div className="hud-right">
          <div className="hud-label">PARAMETERS:</div>
          <NoiseColumn rows={3} seed={2} />
        </div>
      </header>

      {ORDER.map((id, i) => {
        const e = eligibility?.[id];
        const locked = lock > i || (sweepDone && lock >= 0);
        const scanning = lock === i;
        const blocked = locked && e && !e.allowed;
        const leg = legs.find((l) => l.venue === id);
        return (
          <div
            key={id}
            className={`hud-target ${scanning ? "is-scanning" : ""} ${locked ? "is-locked" : ""} ${blocked ? "is-blocked" : ""} ${leg ? "is-chosen" : ""}`}
            style={{ left: `${TARGET_X[i]}%` }}
          >
            <div className="hud-heatbody" aria-hidden />
            <div className="hud-bracket" aria-hidden />
            <div className="hud-tname">{VENUES[id].hud}</div>
            {locked && (
              <div className="hud-params">
                {targetParams(id, state).map((p) => <div key={p}>{p}</div>)}
                {jevFor(id, state).map(([n, s]) => <JevBar key={n} name={n} s={s} />)}
                {blocked && <div className="hud-excluded">TARGET EXCLUDED: {e!.reasons[0].replace(/_/g, " ")}</div>}
                {leg && <div className="hud-leg">ALLOCATE {leg.pct}% · {usd(leg.usd, 2)}</div>}
              </div>
            )}
          </div>
        );
      })}

      {phase !== "idle" && phase !== "profile" && phase !== "scanning_wallet" && (
        <div className={`hud-reticle ${sweepDone ? "is-center" : ""}`} style={reticle} aria-hidden>
          <div className="hud-ring" />
        </div>
      )}

      <div className="hud-result">
      {showList && (
        <div className="hud-list">
          <div className="hud-label">POSSIBLE ALLOCATION:</div>
          {decision.candidates.map((c, i) => (
            <div key={c.id} className={`hud-option ${i === cursor ? "is-cursor" : ""} ${settled && i === chosenIdx ? "is-picked" : ""}`}>
              <span>{c.label.toUpperCase()}</span>
              <span className="hud-fit">{c.fit}</span>
            </div>
          ))}
          {settled && (
            <div className={`hud-stamp ${verified ? (verified.revised ? "is-corrected" : "is-verified") : "is-pending"}`}>
              {!verified ? "SHADOW AGENT: VERIFYING…" : verified.revised ? "SHADOW AGENT CORRECTION" : "SHADOW AGENT: VERIFIED"}
            </div>
          )}
          {settled && verified?.revised && verified.result.decision && (
            <div className="hud-correction">{verified.result.decision.summary}</div>
          )}
        </div>
      )}

      {legs.length > 0 && (
        <div className="hud-split">
          {legs.map((l) => (
            <div key={l.venue} className="hud-splitrow">
              <span>{VENUES[l.venue].hud}</span>
              <span className="hud-splitbar"><span style={{ width: `${l.pct}%` }} /></span>
              <span>{l.pct}% {usd(l.usd, 2)}</span>
            </div>
          ))}
        </div>
      )}
      </div>

      <footer className="hud-bottom">
        <div>
          <div className="hud-label">TRAJECTORY LOGGING:</div>
          {log.map((l, i) => <div key={i} className="hud-logline">{l}</div>)}
        </div>
        <div className="hud-right">
          <div className="hud-label">THREAT ASSESSMENT:</div>
          <div>{eligibility ? `${Object.values(eligibility).filter((x) => !x.allowed).length} TARGETS EXCLUDED` : "PENDING"}</div>
          <div>{signals ? (signals.market.weekend ? "WEEKEND: STOCK ORACLES FROZEN" : signals.market.session.toUpperCase()) : "—"}</div>
        </div>
      </footer>
    </div>
  );
}
