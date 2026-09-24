"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { VENUES, type VenueId } from "@/lib/config";
import { whenIntroDone } from "@/components/Intro";
import type { Position, Profile } from "@/lib/types";
import { DRIFT_PP } from "@/lib/rulebook";
import { GUARD_STORE_KEY, type Execution, type GuardSource, type GuardSession, type RunState, type ScanResult } from "@/lib/use-t1000";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { WalletGuide } from "@/components/WalletGuide";
import { setSoundEnabled, soundStore } from "@/lib/soundtrack";

type Step = {
  key: keyof Profile;
  ask: string;
  options?: { label: string; value: Profile[keyof Profile] }[];
  placeholder: string;
};

const STEPS: Step[] = [
  { key: "residence", ask: "Where do you live? It decides which markets I'm allowed to touch.", options: [
    { label: "UK", value: "UK" }, { label: "EU", value: "EU" }, { label: "US", value: "US" }, { label: "Elsewhere", value: "OTHER" }], placeholder: "e.g. London, or Amsterdam" },
  { key: "amountUsd", ask: "How much of your idle stables should I put to work?", options: [
    { label: "$100", value: 100 }, { label: "$150", value: 150 }], placeholder: "e.g. all is fine, half, or 120" },
  { key: "horizon", ask: "How long can the money stay put?", options: [
    { label: "Under a month", value: "under_1m" }, { label: "1–3 months", value: "1_3m" }, { label: "3–12 months", value: "3_12m" }, { label: "Over a year", value: "over_1y" }], placeholder: "e.g. about half a year" },
  { key: "instantAccess", ask: "Might you need it back instantly?", options: [
    { label: "Yes, keep it liquid", value: true }, { label: "No, it can wait", value: false }], placeholder: "e.g. it's my rent money" },
  { key: "preference", ask: "Stablecoins only, a mix, or are you happy with volatile assets?", options: [
    { label: "Stable only", value: "stable" }, { label: "A mix", value: "mixed" }, { label: "Volatile is fine", value: "volatile" }], placeholder: "e.g. mostly stables, a little ETH" },
  { key: "risk", ask: "And your risk tolerance?", options: [
    { label: "Low", value: "low" }, { label: "Medium", value: "medium" }, { label: "High", value: "high" }], placeholder: "e.g. I can stomach some swings" },
  { key: "goal", ask: "Anything else about your goal? One line, or skip.", options: [{ label: "Skip", value: "" }], placeholder: "e.g. park it for 6 months, some upside is fine" },
];

type Msg = { from: "agent" | "user"; text: string; kicker?: string };

export type GuardActions = {
  enter: () => void;
  scan: () => void;
  setSource: (s: GuardSource) => void;
  setScenario: (s: GuardSession["scenario"]) => void;
  feed: (amountUsd: number) => void;
  cancelFeed: () => void;
  propose: () => void;
  executeMoves: (mode: "simulate" | "live", passcode?: string) => void;
  applyMoves: () => void;
  dismiss: () => void;
  resume: (address?: string) => void;
};

/**
 * Stress test for the what-if scenario: the smallest ETH move (rounded up to a 10% step) that pushes the ETH leg
 * past the drift band. m solves e*m / (T - e + e*m) = target + band. Null when there is no ETH or it needs > +200%.
 */
function stressMult(positions: Position[], targetPct: number): number | null {
  const e = positions.find((p) => p.venue === "rh_eth")?.usd ?? 0;
  const T = positions.reduce((a, p) => a + p.usd, 0);
  if (e <= 0 || T <= 0) return null;
  const w = targetPct / 100 + DRIFT_PP / 100;
  if (w >= 1) return null;
  const m = (w * (T - e)) / (e * (1 - w));
  // +5% headroom so ordinary price moves between scans don't pull it back under the band.
  const up = Math.max(10, Math.ceil(((m - 1) * 100 + 5) / 10) * 10);
  return up > 200 ? null : 1 + up / 100;
}
const pctMove = (mult: number) => `${mult >= 1 ? "+" : ""}${Math.round((mult - 1) * 100)}%`;
const HANDOFF_MS = 3500;

const CHAIN_NAME = { base: "Base", avalanche: "Avalanche", robinhood: "Robinhood Chain" } as const;
const IDLE_TOKEN = { base: "USDC", avalanche: "USDC", robinhood: "USDG" } as const;
/** A move end in plain words; "idle" is named by the chain of the venue on the other side. */
function endLabel(end: string, other: string) {
  if (end !== "idle") return VENUES[end as VenueId].name;
  if (other === "idle") return "idle stables";
  const chain = VENUES[other as VenueId].chain as keyof typeof CHAIN_NAME;
  return `idle ${IDLE_TOKEN[chain]} on ${CHAIN_NAME[chain]}`;
}
function positionNote(p: Position, apy: number | null | undefined) {
  switch (p.status) {
    case "PENDING_T1": return "Deposit requested; vault shares arrive at settlement (T+1).";
    case "SETTLED": return "Settled: vault shares received.";
    case "EARNING": return `Earning ${apy ?? "?"}%, withdraw any time.`;
    case "HELD": return p.detail;
    default: return "No position.";
  }
}

const noopSubscribe = () => () => {};
const readStoredGuard = () => { try { return localStorage.getItem(GUARD_STORE_KEY); } catch { return null; } };
const readStoredWalletGuard = (address?: string) => { if (!address) return null; try { return localStorage.getItem(`${GUARD_STORE_KEY}.${address.toLowerCase()}`); } catch { return null; } };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const CHAIN_LABEL = { base: "Base", avalanche: "Avalanche", robinhood: "Robinhood Chain" } as const;

/** What a scanned wallet holds per chain, in one sentence (stables and gas), for "My wallet" mode. */
function describeWallet(r: ScanResult): string {
  const parts = (["base", "avalanche", "robinhood"] as const).map((c) => {
    const stable = r.holdings.filter((h) => h.chain === c && h.stable).reduce((a, h) => a + h.amount, 0);
    const gas = r.holdings.find((h) => h.chain === c && !h.stable && h.symbol !== "WETH");
    return `${CHAIN_LABEL[c]}: ${usd(stable)}${stable > 0 && (!gas || gas.amount === 0) ? " (no gas)" : ""}`;
  });
  return `Your wallet holds ${usd(r.idleStablesUsd)} in idle stablecoins. ${parts.join(" · ")}. I only plan with what each chain already holds (no bridging), and the IXS vault needs $100+ USDC on Avalanche.`;
}

const RISK_TEXT = "Real funds from my wallet. This is a hackathon beta and not financial advice. IXS is a regulated RWA vault: deposits settle T+1, exits cost 0.5%, and IXS can reject a request (the USDC comes back). ETH is volatile. I confirm every transaction in my wallet.";

function ExecutionView({ ex, title }: { ex: Execution; title: string }) {
  return (
    <div className="msg msg-agent msg-plan">
      <div className="msg-kicker">
        {title} · {ex.by === "wallet" ? "your wallet · " : ""}{ex.mode === "live" ? "live" : "simulation"} · {ex.status === "running" ? "in progress" : ex.status === "done" ? (ex.mode === "live" ? "all confirmed" : "every step passes, nothing was sent") : "stopped"}
      </div>
      {ex.checks.map((c) => <div key={c} className="plan-adjust">Blocked: {c}</div>)}
      {ex.steps.map((st, i) => (
        <div key={i} className="exec-step">
          <span className={`exec-dot ${st.ok === undefined ? "is-pending" : st.ok ? "is-ok" : "is-fail"}`} />
          <div>
            <div>{st.label}</div>
            <div className="plan-cite">
              {st.chain} · {st.ok === undefined ? "waiting" : st.detail}
              {st.explorer && <> · <a href={st.explorer} target="_blank" rel="noopener noreferrer">view tx</a></>}
            </div>
          </div>
        </div>
      ))}
      {ex.error && <div className="plan-adjust">{ex.error}</div>}
    </div>
  );
}

const DEMO_WALLET = "0x2C12CF9dcb6C4958216e7eCe4c71a2Ebc3db358a";
const DEMOS: Record<string, Profile> = {
  uk: { residence: "UK", amountUsd: 150, horizon: "3_12m", risk: "medium", instantAccess: false, preference: "mixed", goal: "Park my idle stables for 6 months, I'd like about 10% in ETH for upside" },
  "uk-instant": { residence: "UK", amountUsd: 150, horizon: "1_3m", risk: "low", instantAccess: true, preference: "stable", goal: "Emergency fund, I might need it any day" },
  us: { residence: "US", amountUsd: 150, horizon: "over_1y", risk: "high", instantAccess: false, preference: "volatile", goal: "Grow it, I can stomach swings" },
};
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Chat({ state, onScan, onRun, onReset, onExecute, onExecuteWallet, guard: G }: {
  state: RunState;
  onScan: (address: string, walletMode?: boolean) => Promise<ScanResult | null>;
  onRun: (p: Profile) => void;
  onReset: () => void;
  onExecute: (mode: "simulate" | "live", plan: RunState["plan"], profile: Profile | null, passcode?: string) => void;
  onExecuteWallet: (mode: "simulate" | "live", plan: RunState["plan"], profile: Profile | null) => void;
  guard: GuardActions;
}) {
  const { address: connected, isConnected } = useAccount();
  const { connectors, connect, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  // Discovered wallets (EIP-6963) replace the generic "Injected" entry when there are any.
  const walletOptions = connectors.filter((c) => !(c.id === "injected" && connectors.some((o) => o.type === "injected" && o.id !== "injected")));
  const [guideOpen, setGuideOpen] = useState(false);
  const soundOn = useSyncExternalStore(soundStore.subscribe, soundStore.get, soundStore.getServer);
  const [riskOk, setRiskOk] = useState(false);
  const storedMine = useSyncExternalStore(noopSubscribe, () => readStoredWalletGuard(connected), () => null);
  const walletMode = !!state.wallet;
  const walletMismatch = walletMode && !!connected && connected.toLowerCase() !== state.wallet!.toLowerCase();
  const [liveOpen, setLiveOpen] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [movesLiveOpen, setMovesLiveOpen] = useState(false);
  const [movesPasscode, setMovesPasscode] = useState("");
  const storedGuard = useSyncExternalStore(noopSubscribe, readStoredGuard, () => null);
  const [msgs, setMsgs] = useState<Msg[]>([{ from: "agent", text: "I'm T1000. I find idle stablecoins and decide where they should live. Connect your wallet to deploy your own (you confirm every step), or try the demo: the same flow as a full simulation against live mainnet, nothing is sent." }]);
  const [address, setAddress] = useState(DEMO_WALLET);
  const [step, setStep] = useState(-1);
  const [profile, setProfile] = useState<Partial<Profile>>({});
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  // Scroll the chat log itself, never the page (on narrow screens the page would scroll the HUD away).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs, state.phase, state.plan, state.verified, state.execution, state.guard]);

  const say = (m: Msg) => setMsgs((x) => [...x, m]);

  // A finished deploy (or feed) is written into the log, then the vision hands over to Guard mode.
  const handedOff = useRef<Execution | null>(null);
  const feeding = state.guard?.feeding ?? null;
  useEffect(() => {
    const ex = state.execution, plan = state.plan;
    if (!ex || ex.status !== "done" || !plan || handedOff.current === ex) return;
    // The draft's summary explains the plan; the verifier's only replaces it when it corrected the draft.
    const summary = (state.verified?.revised ? state.verified.result.decision : state.fast?.result.decision)?.summary;
    const id = setTimeout(() => {
      handedOff.current = ex;
      const total = plan.legs.reduce((a, l) => a + l.usd, 0);
      say({
        from: "agent",
        kicker: `${feeding != null ? "Fed" : "Deployed"} · ${ex.by === "wallet" ? "from your wallet · " : ""}${ex.mode === "live" ? "live" : "simulated"} · ${usd(total)}`,
        text: `${summary ? summary + " " : ""}${plan.legs.map((l) => `${VENUES[l.venue].name} ${l.pct}% (${usd(l.usd)})`).join(" · ")}. ${ex.steps.length} transactions ${ex.mode === "live" ? "confirmed" : "passed simulation; nothing was sent"}.`,
      });
      say({
        from: "agent",
        text: feeding != null
          ? "Guard is back on, watching the combined positions."
          : "Guard mode is on. Once a minute I re-check each position against your plan and flag drift, a shrinking yield gap, vault rule changes and new cash.",
      });
      G.enter();
    }, HANDOFF_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.execution, state.plan]);

  // Finished moves are written into the log, then Guard takes them on board and re-scans.
  const movesHandedOff = useRef<Execution | null>(null);
  const moves = state.guard?.moves ?? null;
  const movePlan = state.guard?.rebalance?.plan ?? null;
  useEffect(() => {
    if (!moves || moves.status !== "done" || !movePlan || movesHandedOff.current === moves) return;
    const id = setTimeout(() => {
      movesHandedOff.current = moves;
      say({
        from: "agent",
        kicker: `Rebalanced · ${moves.mode === "live" ? "live" : "simulated"}`,
        text: `${movePlan.summary} ${moves.steps.length} transactions ${moves.mode === "live" ? "confirmed" : "passed simulation; nothing was sent"}.`,
      });
      G.applyMoves();
    }, HANDOFF_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moves, movePlan]);

  // ?demo=<profile> auto-plays a scripted run (testing and demo recording). The goal line is part of the script.
  const autoRan = useRef(false);
  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("demo");
    const demo = key ? DEMOS[key] : undefined;
    if (!demo || autoRan.current) return;
    autoRan.current = true;
    whenIntroDone(async () => {
      say({ from: "user", text: `Scan ${DEMO_WALLET.slice(0, 6)}…${DEMO_WALLET.slice(-4)}` });
      const r = await onScan(DEMO_WALLET);
      if (r) say({ from: "agent", text: `I see ${usd(r.idleStablesUsd)} in idle stablecoins across Base, Avalanche and Robinhood Chain.` });
      for (const s of STEPS) {
        say({ from: "agent", text: s.ask });
        const v = demo[s.key];
        const label = s.options?.find((o) => o.value === v)?.label ?? (s.key === "amountUsd" ? usd(v as number) : String(v || "Skip"));
        say({ from: "user", text: label });
      }
      setStep(STEPS.length);
      say({ from: "agent", text: "Scanning the market. Watch the left side." });
      onRun(demo);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scan() {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { say({ from: "agent", text: "That doesn't look like a wallet address." }); return; }
    say({ from: "user", text: `Scan ${short(address)} (demo)` });
    const r = await onScan(address);
    if (!r) { say({ from: "agent", text: "I couldn't read that wallet. Try again in a moment." }); return; }
    say({
      from: "agent",
      text: `I see ${usd(r.idleStablesUsd)} in idle stablecoins across Base, Avalanche and Robinhood Chain. This is the demo: every run is simulated against live mainnet and nothing is sent.`,
    });
    setStep(0);
    say({ from: "agent", text: STEPS[0].ask });
  }

  /** "My wallet" mode: scan the connected wallet; plans and transactions are for this address. */
  async function scanMine() {
    if (!connected) return;
    say({ from: "user", text: `Scan my wallet ${short(connected)}` });
    const r = await onScan(connected, true);
    if (!r) { say({ from: "agent", text: "I couldn't read your wallet. Try again in a moment." }); return; }
    if (!r.walletEnabled) { say({ from: "agent", text: "Wallet mode is switched off right now. The demo still works." }); return; }
    say({ from: "agent", text: describeWallet(r) });
    if (r.idleStablesUsd < 5) {
      say({ from: "agent", text: "There's not enough here to deploy yet. Add USDC on Base or Avalanche (or USDG on Robinhood Chain) plus a little gas, or try the demo." });
      return;
    }
    setStep(0);
    say({ from: "agent", text: STEPS[0].ask });
  }

  const [busy, setBusy] = useState(false);

  /** Records one answer. `shown` is the user's bubble; `echo` is the agent's read-back when it interpreted free text. */
  function answer(shown: string, value: Profile[keyof Profile], echo?: string) {
    const s = STEPS[step];
    say({ from: "user", text: shown });
    let v = value;
    const notes: string[] = [];
    if (s.key === "amountUsd") {
      let n = Number(v);
      const idle = state.idleStablesUsd ?? 0;
      if (idle > 0 && n > idle) { n = idle; notes.push(`You hold ${usd(idle)} in idle stables, so I'll work with that.`); }
      const cap = walletMode ? state.walletMaxRunUsd : state.maxRunUsd;
      if (cap && n > cap) { n = cap; notes.push(walletMode ? `Wallet runs are capped at ${usd(cap)} during the beta, so I'll plan ${usd(cap)}.` : `This demo caps each run at ${usd(cap)}, so I'll plan ${usd(cap)}.`); }
      v = n;
    }
    const next = { ...profile, [s.key]: v } as Partial<Profile>;
    setProfile(next);
    setDraft("");
    const lead = [echo, ...notes].filter(Boolean).join(" ");
    if (step + 1 < STEPS.length) {
      setStep(step + 1);
      say({ from: "agent", text: (lead ? lead + " " : "") + STEPS[step + 1].ask });
    } else {
      setStep(STEPS.length);
      say({ from: "agent", text: (lead ? lead + " " : "") + "Scanning the market. Watch the left side." });
      onRun({ goal: "", ...next } as Profile);
    }
  }

  /** Free text for any question: rules for amounts, Jev for the choices. */
  async function submitText(text: string) {
    const s = STEPS[step];
    const t = text.trim();
    if (!t || busy) return;
    if (s.key === "goal") { answer(t, t.slice(0, 400)); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: s.key, text: t, idleUsd: state.idleStablesUsd ?? 0 }),
      });
      const r = (await res.json()) as { ok: boolean; value?: Profile[keyof Profile]; label?: string; message?: string };
      if (r.ok && r.value !== undefined) answer(t, r.value, `Got it: ${r.label}.`);
      else { say({ from: "user", text: t }); say({ from: "agent", text: r.message ?? "Pick one of the options below." }); setDraft(""); }
    } catch {
      say({ from: "user", text: t });
      say({ from: "agent", text: "I couldn't read that just now. Pick one of the options below." });
    } finally {
      setBusy(false);
    }
  }

  const current = step >= 0 && step < STEPS.length ? STEPS[step] : null;
  const fastDecision = state.fast?.result.decision;
  const verifiedDecision = state.verified?.result.decision;
  const reasons = useMemo(() => (verifiedDecision ?? fastDecision)?.reasons ?? [], [verifiedDecision, fastDecision]);

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="chat-dot" /> T1000 agent
        <button className="chat-guide" onClick={() => setGuideOpen(true)}>Use your own wallet</button>
        <button className="chat-sound" onClick={() => setSoundEnabled(!soundOn)} aria-label={soundOn ? "Mute soundtrack" : "Play soundtrack"} title={soundOn ? "Mute soundtrack" : "Play soundtrack"}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M11 5 6 9H3v6h3l5 4z" />
            {soundOn ? <><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></> : <><path d="m16 9 5 6" /><path d="m21 9-5 6" /></>}
          </svg>
        </button>
        <button className="chat-reset" onClick={onReset} title="Start again from the intro">Restart</button>
      </div>

      {guideOpen && <WalletGuide onClose={() => setGuideOpen(false)} walletMaxRunUsd={state.walletMaxRunUsd} />}
      <div className="chat-log" ref={logRef}>
        {msgs.map((m, i) => (
          <div key={i} className={`msg msg-${m.from}`}>
            {m.kicker && <div className="msg-kicker">{m.kicker}</div>}
            {m.text}
          </div>
        ))}

        {fastDecision && (
          <div className="msg msg-agent">
            <div className="msg-kicker">SERV draft · {(state.fast!.result.ms / 1000).toFixed(1)}s</div>
            {fastDecision.summary}
          </div>
        )}

        {state.verified && (
          <div className="msg msg-agent">
            <div className="msg-kicker">
              Shadow Agent · {(state.verified.result.ms / 1000).toFixed(1)}s · {state.verified.result.ok ? (state.verified.revised ? "corrected the draft" : "verified, no changes") : "could not verify"}
            </div>
            {state.verified.revised && verifiedDecision ? verifiedDecision.summary : state.verified.result.ok ? "The draft holds up against every rule and the policy." : state.verified.result.error}
          </div>
        )}

        {state.plan && (
          <div className="msg msg-agent msg-plan">
            <div className="msg-kicker">Plan · {usd(state.plan.legs.reduce((a, l) => a + l.usd, 0))}</div>
            {state.plan.legs.map((l) => (
              <div key={l.venue} className="plan-leg">
                <div className="plan-row"><strong>{VENUES[l.venue].name}</strong><span>{l.pct}% · {usd(l.usd)}</span></div>
                {reasons.filter((r) => r.venue === l.venue).flatMap((r) => r.cites).slice(0, 2).map((c) => <div key={c} className="plan-cite">{c}</div>)}
              </div>
            ))}
            {verifiedDecision?.blocked.length ? (
              <div className="plan-blocked">Excluded: {verifiedDecision.blocked.map((b) => `${VENUES[b.venue].name} (${b.reason.replace(/_/g, " ").toLowerCase()})`).join(", ")}</div>
            ) : null}
            {state.plan.adjustments.map((a) => <div key={a} className="plan-adjust">Guard: {a}</div>)}
            {state.plan.blocked.length > 0 && (
              <div className="plan-adjust wallet-block">
                Your wallet can&apos;t fund this split: {state.plan.blocked.join(" ")} Restart with a smaller amount, or add funds on that chain.
              </div>
            )}
            {state.plan.verified && state.plan.planToken && walletMode ? (
              <div className="exec-actions">
                {walletMismatch ? (
                  <div className="plan-adjust wallet-block">Your wallet switched accounts since the scan. Restart to plan for the new one.</div>
                ) : (
                  <>
                    <label className="risk">
                      <input type="checkbox" checked={riskOk} onChange={(e) => setRiskOk(e.target.checked)} />
                      <span>{RISK_TEXT}</span>
                    </label>
                    <button className="btn-approve" disabled={!riskOk || !isConnected || state.execution?.status === "running"} onClick={() => onExecuteWallet("live", state.plan, state.profile)}>
                      {state.execution?.status === "running" && state.execution.mode === "live" ? "Confirm each step in your wallet…" : "Deploy from my wallet"}
                    </button>
                    <button className="btn-live-link" disabled={state.execution?.status === "running"} onClick={() => onExecuteWallet("simulate", state.plan, state.profile)}>
                      Check it first: simulate from my wallet (nothing is sent)
                    </button>
                  </>
                )}
              </div>
            ) : state.plan.verified && state.plan.planToken ? (
              <div className="exec-actions">
                <button className="btn-approve" disabled={state.execution?.status === "running"} onClick={() => onExecute("simulate", state.plan, state.profile)}>
                  {state.execution?.status === "running" && state.execution.mode === "simulate" ? "Simulating…" : "Simulate the run (no funds move)"}
                </button>
                {!liveOpen ? (
                  <button className="btn-live-link" onClick={() => setLiveOpen(true)}>Operator: run live</button>
                ) : (
                  <form className="chat-row" onSubmit={(e) => { e.preventDefault(); onExecute("live", state.plan, state.profile, passcode); setPasscode(""); }}>
                    <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="Operator passcode" aria-label="Operator passcode" autoComplete="off" />
                    <button type="submit" disabled={!passcode || state.execution?.status === "running"}>Run live</button>
                  </form>
                )}
              </div>
            ) : (
              <button className="btn-approve" disabled>{state.plan.blocked.length ? "This wallet can't fund this split" : "Not verified: cannot execute"}</button>
            )}
          </div>
        )}

        {state.execution && <ExecutionView ex={state.execution} title={feeding != null ? "Feed" : "Deploy"} />}

        {state.guard && feeding == null && <GuardCard state={state} G={G} />}

        {state.guard?.rebalance && feeding == null && (
          <RebalanceCard
            state={state} G={G} liveOpen={movesLiveOpen} setLiveOpen={setMovesLiveOpen} passcode={movesPasscode} setPasscode={setMovesPasscode}
          />
        )}
        {state.guard?.moves && feeding == null && <ExecutionView ex={state.guard.moves} title="Moves" />}

        {state.phase === "error" && <div className="msg msg-agent msg-error">{state.error}</div>}
      </div>

      <div className="chat-input">
        {step === -1 && !state.guard && (
          <>
            <div className="wallet-box">
              <div className="wallet-title">Use your own wallet</div>
              {isConnected && connected ? (
                <div className="wallet-row">
                  <span className="wallet-addr">{short(connected)}</span>
                  <button className="btn-approve wallet-scan" onClick={scanMine} disabled={state.phase === "scanning_wallet"}>
                    {state.phase === "scanning_wallet" ? "Scanning…" : "Scan my wallet"}
                  </button>
                  <button className="btn-live-link" onClick={() => disconnect()}>Disconnect</button>
                </div>
              ) : (
                <div className="chips">
                  {walletOptions.map((c) => (
                    <button key={c.uid} disabled={connecting} onClick={() => connect({ connector: c })}>{c.name === "Injected" ? "Browser wallet" : c.name}</button>
                  ))}
                </div>
              )}
              {connectError && <div className="plan-cite">{connectError.message.split("\n")[0]}</div>}
              {storedMine && connected && (
                <button className="btn-live-link" onClick={() => { say({ from: "agent", text: "Resuming Guard on your wallet's live positions." }); G.resume(connected); }}>
                  Resume Guard on my wallet
                </button>
              )}
            </div>
            <div className="wallet-title">Or try the demo (full simulation, nothing is sent)</div>
            <div className="chat-row">
              <input value={address} onChange={(e) => setAddress(e.target.value.trim())} spellCheck={false} aria-label="Wallet address" />
              <button onClick={scan} disabled={state.phase === "scanning_wallet"}>{state.phase === "scanning_wallet" ? "Scanning…" : "Scan (demo)"}</button>
            </div>
            {storedGuard && (
              <button className="btn-live-link" onClick={() => { say({ from: "agent", text: "Resuming Guard on the agent wallet's live positions." }); G.resume(); }}>
                Operator: resume Guard on the live deployment
              </button>
            )}
          </>
        )}
        {state.guard && feeding != null && (
          <div className="chat-wait">
            Feeding {usd(feeding)} through the pipeline. <button className="btn-live-link" onClick={G.cancelFeed}>Back to Guard</button>
          </div>
        )}
        {current && !state.guard && (
          <>
            <div className="chips">
              {current.options?.map((o) => <button key={o.label} disabled={busy} onClick={() => answer(o.label, o.value)}>{o.label}</button>)}
            </div>
            <form className="chat-row" onSubmit={(e) => { e.preventDefault(); submitText(draft); }}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={current.placeholder} aria-label="Your answer" disabled={busy} />
              <button type="submit" disabled={busy || !draft.trim()}>{busy ? "Reading…" : "Send"}</button>
            </form>
          </>
        )}
        {step >= STEPS.length && !state.guard && state.phase !== "done" && state.phase !== "error" && <div className="chat-wait">T1000 is thinking…</div>}
      </div>
    </div>
  );
}

function GuardCard({ state, G }: { state: RunState; G: GuardActions }) {
  const g = state.guard!;
  const { data, session } = g;
  const total = data?.positions.reduce((a, p) => a + p.usd, 0) ?? 0;
  const target = (v: VenueId) => session.legs.find((l) => l.venue === v)?.pct ?? 0;
  const triggers = data?.triggers ?? [];
  const actionable = triggers.filter((t) => t.code !== "NEW_CASH");
  const fresh = data ? Math.floor((data.idleUsd - data.idleAtDeployUsd) * 100) / 100 : 0;
  const feedUsd = Math.min(fresh, state.maxRunUsd ?? fresh);
  const busy = !!g.rebalance || !!g.moves;
  const stress = data && !session.scenario ? stressMult(data.positions, target("rh_eth")) : null;
  return (
    <div className="msg msg-agent msg-plan">
      <div className="msg-kicker">
        Guard · {session.source === "live" ? (session.address ? "your wallet, onchain" : "agent wallet, onchain") : "simulated positions"}
        {session.scenario && " · scenario"} · {g.scanning ? "scanning…" : data ? `checked ${new Date(data.at).toLocaleTimeString()}` : "…"}
      </div>
      <div className="seg" role="group" aria-label="Positions source">
        <button className={session.source === "simulated" ? "is-on" : ""} disabled={busy} onClick={() => G.setSource("simulated")}>Simulated</button>
        <button className={session.source === "live" ? "is-on" : ""} disabled={busy} onClick={() => G.setSource("live")}>{session.address ? "My wallet (onchain)" : "Agent wallet (onchain)"}</button>
      </div>
      {session.scenario && (
        <div className="guard-scenario">SCENARIO: ETH {pctMove(session.scenario.ethMult)} from the live price, the smallest move that breaks your 5pp band. What-if only; it never reaches a live run.</div>
      )}
      {data?.positions.filter((p) => p.usd > 0 || target(p.venue) > 0).map((p) => (
        <div key={p.venue} className="plan-leg">
          <div className="plan-row">
            <strong>{VENUES[p.venue].name}</strong>
            <span>{usd(p.usd)} · {total > 0 ? ((p.usd / total) * 100).toFixed(1) : "0.0"}%</span>
          </div>
          <div className="plan-cite">Target {target(p.venue)}% · {positionNote(p, data.signals.base.netApyPct)}</div>
        </div>
      ))}
      {data && total === 0 && (
        <div className="plan-cite guard-clear-note">
          {session.source === "live"
            ? (session.address ? "Your wallet holds no T1000 positions yet. They appear here once your deploy confirms." : "The agent wallet holds no positions yet. Positions appear here after an operator's live run.")
            : "No positions to watch."}
        </div>
      )}
      {data && total === 0 && triggers.map((t, i) => <div key={i} className="guard-trig"><span className="guard-code">{t.code.replace(/_/g, " ")}</span>{t.detail}</div>)}
      {data && total > 0 && (triggers.length ? (
        triggers.map((t, i) => <div key={i} className="guard-trig"><span className="guard-code">{t.code.replace(/_/g, " ")}</span>{t.detail}</div>)
      ) : (
        <div className="plan-cite guard-clear-note">All clear: every position is within 5pp of its target.</div>
      ))}
      {g.error && <div className="plan-adjust">{g.error}</div>}
      <div className="exec-actions">
        {fresh >= 20 && feedUsd > 0 && !busy && (
          <button className="btn-approve" onClick={() => G.feed(feedUsd)}>Feed {usd(feedUsd)} of new cash into the plan</button>
        )}
        {actionable.length > 0 && !busy && <button className="btn-approve" onClick={G.propose}>Ask SERV for a rebalance</button>}
        <div className="guard-tools">
          {session.source === "simulated" && (session.scenario || stress) && (
            <button disabled={busy} onClick={() => G.setScenario(session.scenario ? null : { ethMult: stress! })}>
              {session.scenario ? "Clear stress test" : `Stress test: ETH ${pctMove(stress!)}`}
            </button>
          )}
          <button disabled={g.scanning || busy} onClick={G.scan}>Scan now</button>
        </div>
      </div>
    </div>
  );
}

function RebalanceCard({ state, G, liveOpen, setLiveOpen, passcode, setPasscode }: {
  state: RunState; G: GuardActions;
  liveOpen: boolean; setLiveOpen: (v: boolean) => void; passcode: string; setPasscode: (v: string) => void;
}) {
  const g = state.guard!;
  const rb = g.rebalance!;
  const plan = rb.plan;
  const running = g.moves?.status === "running";
  const canLive = g.session.source === "live" && !g.session.scenario;
  const byWallet = canLive && !!g.session.address;
  // A correction means different moves; a reworded summary alone is not one.
  const key = (d?: { moves: { from: string; to: string; usd: number }[] } | null) => JSON.stringify(d?.moves.map((m) => [m.from, m.to, m.usd]) ?? null);
  const corrected = !!rb.verified?.ok && !!rb.verified.value && !!rb.fast?.value && key(rb.verified.value) !== key(rb.fast.value);
  return (
    <div className="msg msg-agent msg-plan">
      <div className="msg-kicker">
        SERV rebalance · {rb.status === "running" ? (!rb.fast ? "drafting…" : "Shadow Agent verifying…") : rb.status === "done" ? "proposal" : "stopped"}
      </div>
      {rb.status === "running" && !rb.fast && <div className="plan-cite">Multipath is weighing the moves against your plan.</div>}
      {rb.fast && (
        <div className="plan-leg">
          <div className="plan-cite">Draft · {(rb.fast.ms / 1000).toFixed(1)}s</div>
          {rb.fast.value?.summary ?? rb.fast.error}
        </div>
      )}
      {rb.verified && (
        <div className="plan-leg">
          <div className="plan-cite">
            Shadow Agent · {(rb.verified.ms / 1000).toFixed(1)}s · {!rb.verified.ok ? "could not verify" : corrected ? "corrected the draft" : "verified, no changes"}
          </div>
          {corrected ? rb.verified.value!.summary : null}
        </div>
      )}
      {plan?.moves.map((m, i) => {
        const deferred = m.bridge_required || (m.from === "idle") === (m.to === "idle");
        return (
          <div key={i} className="plan-leg">
            <div className="plan-row">
              <strong>{endLabel(m.from, m.to)} → {endLabel(m.to, m.from)}</strong>
              <span>{deferred ? "Bridge required · next version" : usd(m.usd)}</span>
            </div>
            <div className="plan-cite">{m.why}</div>
          </div>
        );
      })}
      {plan && !plan.moves.length && <div className="plan-cite">SERV proposes holding: no moves.</div>}
      {plan?.check.errors.map((e) => <div key={e} className="plan-adjust">Blocked by the code guard: {e}</div>)}
      {rb.error && <div className="plan-adjust">{rb.error}</div>}
      {plan?.planToken && !g.moves && (
        <div className="exec-actions">
          <button className="btn-approve" disabled={running} onClick={() => G.executeMoves("simulate")}>Simulate the moves (no funds move)</button>
          {byWallet && (
            <button className="btn-approve" disabled={running} onClick={() => G.executeMoves("live")}>Sign the moves in my wallet</button>
          )}
          {canLive && !byWallet && (!liveOpen ? (
            <button className="btn-live-link" onClick={() => setLiveOpen(true)}>Operator: run live</button>
          ) : (
            <form className="chat-row" onSubmit={(e) => { e.preventDefault(); G.executeMoves("live", passcode); setPasscode(""); }}>
              <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="Operator passcode" aria-label="Operator passcode" autoComplete="off" />
              <button type="submit" disabled={!passcode || running}>Run live</button>
            </form>
          ))}
        </div>
      )}
      {plan && !plan.planToken && <div className="plan-cite">Nothing here can be executed in this version.</div>}
      {rb.status !== "running" && !running && <button className="btn-live-link" onClick={G.dismiss}>Dismiss</button>}
    </div>
  );
}
