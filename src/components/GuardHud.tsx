"use client";
// Guard mode: the same infrared vision, now watching deployed positions. Triggers come from the rulebook in code,
// never from the model; SERV is only asked for moves once one fires.
import { useEffect, useState } from "react";
import { VENUES, type VenueId } from "@/lib/config";
import { DRIFT_PP, NEW_CASH_USD, YIELD_GAP_PP } from "@/lib/rulebook";
import { GUARD_SCAN_MS, type GuardView } from "@/lib/use-t1000";

const ORDER: VenueId[] = ["base", "ixs", "rh_eth"];
const X = [18, 50, 82];

const usd = (n: number | null | undefined, d = 2) =>
  n == null ? "N/A" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const SHORT: Record<VenueId, string> = { base: "BASE", ixs: "IXS", rh_eth: "ETH", rh_stocks: "STOCKS" };
const clock = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
const endName = (e: string) => (e === "idle" ? "IDLE" : VENUES[e as VenueId].hud);

export function GuardHud({ guard }: { guard: GuardView }) {
  const { data, session, rebalance, moves } = guard;
  const [now, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const positions = data?.positions ?? [];
  const total = positions.reduce((a, p) => a + p.usd, 0);
  const weight = (v: VenueId) => (total > 0 ? ((positions.find((p) => p.venue === v)?.usd ?? 0) / total) * 100 : 0);
  const target = (v: VenueId) => session.legs.find((l) => l.venue === v)?.pct ?? 0;
  const triggers = data?.triggers ?? [];
  const alerts = triggers.filter((t) => t.code !== "NEW_CASH");
  const alertVenues = new Set(alerts.map((t) => t.venue).filter(Boolean));
  const newCash = triggers.find((t) => t.code === "NEW_CASH");

  const busy = !!rebalance || !!moves;
  const nextScan = guard.lastScanAt && !busy && guard.feeding == null ? Math.max(0, guard.lastScanAt + GUARD_SCAN_MS - now) : null;
  const countdown = guard.scanning ? "SCANNING" : nextScan == null || now === 0 ? (busy ? "PAUSED" : "--:--") : clock(Math.ceil(nextScan / 1000));

  const mode = moves ? (moves.status === "running" ? "EXECUTING MOVES" : moves.status === "done" ? "MOVES COMPLETE" : "MOVES STOPPED")
    : rebalance?.status === "running" ? (!rebalance.fast ? "SERV MULTIPATH REASONING" : "SHADOW AGENT VERIFYING")
      : rebalance?.status === "done" ? "PROPOSAL READY"
        : alerts.length ? `ALERT: ${[...new Set(alerts.map((a) => a.code))].join(" + ").replace(/_/g, " ")}`
          : guard.scanning && !data ? "ACQUIRING POSITIONS" : "WATCHING";

  // Reticle: sweeps the positions while watching; locks onto the first alert.
  const alertIdx = ORDER.findIndex((v) => alertVenues.has(v));
  const sweepIdx = now === 0 ? 0 : Math.floor(now / 1800) % ORDER.length;
  const reticleIdx = alertIdx >= 0 ? alertIdx : sweepIdx;

  const s = data?.signals;
  const maxDrift = ORDER.reduce((m, v) => Math.max(m, total > 0 && positions.some((p) => p.venue === v) ? Math.abs(weight(v) - target(v)) : 0), 0);
  const fresh = data ? data.idleUsd - data.idleAtDeployUsd : 0;
  // Short form so the row fits at stream size: "ETH 15.9% VS 10% TARGET".
  const drift = alerts.find((t) => t.code === "DRIFT");
  const driftText = drift ? (drift.venue ? `${SHORT[drift.venue]} ${weight(drift.venue).toFixed(1)}% VS ${target(drift.venue)}% TARGET` : drift.detail) : null;
  const watch = [
    { code: "DRIFT", alert: alerts.some((t) => t.code === "DRIFT"), text: driftText ?? `MAX ${maxDrift.toFixed(1)}PP OF ${DRIFT_PP}PP` },
    { code: "YIELD GAP", alert: alerts.some((t) => t.code === "YIELD_GAP"), text: s ? `IXS ${s.ixs.estYieldPct}% VS BASE ${s.base.netApyPct ?? "N/A"}% (MIN ${YIELD_GAP_PP}PP)` : "PENDING" },
    { code: "VAULT RULES", alert: alerts.some((t) => t.code === "VAULT_RULE"), text: s ? `PAUSE ${s.ixs.paused ? "ON" : "OFF"} · WHITELIST ${s.ixs.whitelistEnabled ? "ON" : "OFF"} · NAV ${s.ixs.navFresh === false ? "STALE" : "FRESH"}` : "PENDING" },
    { code: "NEW CASH", alert: !!newCash, text: data ? `IDLE ${usd(data.idleUsd)} (${fresh >= 0 ? "+" : ""}${usd(fresh)} VS ${usd(NEW_CASH_USD, 0)} MIN)` : "PENDING" },
  ];

  const plan = rebalance?.plan;
  // The draft's moves show while the Shadow Agent verifies; the checked plan replaces them.
  const shownMoves = plan?.moves ?? rebalance?.fast?.value?.moves ?? null;
  const log: string[] = [];
  if (data) log.push(`GUARD SCAN ${data.at.slice(11, 19)}Z ${data.source === "live" ? "ONCHAIN" : "PROJECTED"}`);
  if (data) log.push(`POSITIONS ${usd(total)} ACROSS ${positions.filter((p) => p.usd > 0).length} VENUES`);
  for (const t of triggers) log.push(`TRIGGER ${t.code.replace(/_/g, " ")}`);
  if (rebalance?.fast) log.push(`SERV REBALANCE DRAFT ${(rebalance.fast.ms / 1000).toFixed(1)}S`);
  if (rebalance?.verified) log.push(`SHADOW AGENT ${rebalance.verified.ok ? "PASSED" : "FAILED"} ${(rebalance.verified.ms / 1000).toFixed(1)}S`);
  if (plan) log.push(`CODE GUARD ${plan.check.errors.length ? "BLOCKED" : `${plan.check.executable.length} MOVES CLEARED`}`);
  if (moves) log.push(`MOVES ${moves.mode === "live" ? "LIVE" : "SIMULATED"} ${moves.status.toUpperCase()}`);
  if (guard.error) log.push(`FAULT ${guard.error.toUpperCase()}`);

  return (
    <div className={`hud is-guard ${alerts.length ? "is-alert" : ""}`}>
      <div className="hud-heat" aria-hidden />
      <div className="hud-horizon" aria-hidden />
      <div className="guard-flash" aria-hidden />

      <header className="hud-top">
        <div>
          <div className="hud-title">T1000 // GUARD MODE</div>
          <div className="hud-sub">MODE: {mode}</div>
        </div>
        <div className="hud-right">
          <div className="hud-label">SOURCE: {session.source === "live" ? "AGENT WALLET · ONCHAIN" : "SIMULATED POSITIONS"}</div>
          <div><span className="guard-src-short">{session.source === "live" ? "ONCHAIN" : "SIMULATED"} · </span>NEXT SCAN {countdown}</div>
          {session.scenario && <div className="guard-tag">SCENARIO: ETH {session.scenario.ethMult >= 1 ? "+" : ""}{Math.round((session.scenario.ethMult - 1) * 100)}%</div>}
        </div>
      </header>

      {ORDER.map((id, i) => {
        const p = positions.find((x) => x.venue === id);
        const empty = !p || p.usd <= 0;
        const w = weight(id), t = target(id);
        const alert = alerts.find((t) => t.venue === id);
        const status = !p ? "ACQUIRING" : p.status === "EMPTY" ? "NO POSITION"
          : p.status === "PENDING_T1" ? "PENDING T+1" : p.status === "SETTLED" ? "SETTLED · SHARES IN"
            : p.status === "EARNING" ? `EARNING ${s?.base.netApyPct ?? "?"}%` : p.detail.replace(/^Projected: /, "").toUpperCase();
        return (
          <div key={id} className={`hud-target is-locked guard-target ${alert ? "is-alert" : ""} ${empty ? "is-empty" : "is-chosen"}`} style={{ left: `${X[i]}%` }}>
            <div className="hud-heatbody" aria-hidden />
            <div className="hud-bracket" aria-hidden />
            <div className="hud-tname">{VENUES[id].hud}</div>
            <div className="hud-params">
              <div className="hud-leg">{p ? `${usd(p.usd)} · ${w.toFixed(1)}%` : "…"}</div>
              <div>{status}</div>
              <div className="guard-weight">
                <span>WT</span>
                <span className="guard-track"><span style={{ width: `${Math.min(100, w)}%` }} /><i style={{ left: `${t}%` }} /></span>
                <span>TGT {t}%</span>
              </div>
              {alert && <div className="hud-excluded">{alert.code === "DRIFT" ? `DRIFT ${w - t >= 0 ? "+" : ""}${(w - t).toFixed(1)}PP` : alert.code.replace(/_/g, " ")}</div>}
            </div>
          </div>
        );
      })}

      <div className={`hud-reticle ${alertIdx >= 0 ? "is-lock" : ""}`} style={{ left: `${X[reticleIdx]}%` }} aria-hidden>
        <div className="hud-ring" />
      </div>

      <div className="guard-result">
        <div className="guard-watch">
          <div className="hud-label">GUARD WATCH LIST:</div>
          {watch.map((r) => (
            <div key={r.code} className={`guard-row ${r.alert ? "is-alert" : "is-ok"}`}>
              <span>{r.code}</span>
              <span>{r.text.toUpperCase()}</span>
              <span>{r.alert ? "ALERT" : "OK"}</span>
            </div>
          ))}
          {!watch.some((r) => r.alert) && (
            <div className="guard-row guard-clear"><span>{data && total === 0 ? "NO POSITIONS HELD" : "ALL CLEAR"}</span><span /><span /></div>
          )}
        </div>

        {rebalance && (
          <div className="guard-proposal">
            <div className="hud-label">SERV REBALANCE:</div>
            {!shownMoves && <div className="guard-move">{rebalance.status === "error" ? "NO PROPOSAL" : "REASONING…"}</div>}
            {shownMoves?.map((m, i) => {
              // Executable only when exactly one side is idle (same chain); anything else needs a bridge.
              const deferred = m.bridge_required || (m.from === "idle") === (m.to === "idle");
              return (
                <div key={i} className={`guard-move ${deferred ? "is-deferred" : ""}`}>
                  <span>{endName(m.from)} → {endName(m.to)}</span>
                  <span>{deferred ? "BRIDGE REQUIRED · NEXT" : usd(m.usd)}</span>
                </div>
              );
            })}
            {shownMoves && !shownMoves.length && <div className="guard-move">HOLD: NO MOVES</div>}
            {(rebalance.fast || rebalance.status === "running") && (
              <div className={`hud-stamp ${rebalance.verified ? (rebalance.verified.ok ? "is-verified" : "is-corrected") : "is-pending"}`}>
                {!rebalance.verified ? "SHADOW AGENT: VERIFYING…" : rebalance.verified.ok ? "SHADOW AGENT: VERIFIED" : "SHADOW AGENT: FAILED"}
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="hud-bottom">
        <div>
          <div className="hud-label">TRAJECTORY LOGGING:</div>
          {log.slice(-6).map((l, i) => <div key={i} className="hud-logline">{l}</div>)}
        </div>
        <div className="hud-right">
          <div className="hud-label">THREAT ASSESSMENT:</div>
          <div>{!data ? "PENDING" : alerts.length ? `${alerts.length} ALERT${alerts.length > 1 ? "S" : ""}` : total === 0 ? "NOTHING DEPLOYED" : "ALL CLEAR"}</div>
          <div>{data ? `HELD ${usd(total)} · IDLE ${usd(data.idleUsd)}` : "—"}</div>
        </div>
      </footer>
    </div>
  );
}
