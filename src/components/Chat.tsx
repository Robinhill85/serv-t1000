"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { VENUES } from "@/lib/config";
import type { Profile } from "@/lib/types";
import type { RunState } from "@/lib/use-t1000";

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

type Msg = { from: "agent" | "user"; text: string };

const DEMO_WALLET = "0x2C12CF9dcb6C4958216e7eCe4c71a2Ebc3db358a";
const DEMOS: Record<string, Profile> = {
  uk: { residence: "UK", amountUsd: 150, horizon: "3_12m", risk: "medium", instantAccess: false, preference: "mixed", goal: "Park my idle stables for 6 months, some upside is fine" },
  "uk-instant": { residence: "UK", amountUsd: 150, horizon: "1_3m", risk: "low", instantAccess: true, preference: "stable", goal: "Emergency fund, I might need it any day" },
  us: { residence: "US", amountUsd: 150, horizon: "over_1y", risk: "high", instantAccess: false, preference: "volatile", goal: "Grow it, I can stomach swings" },
};
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Chat({ state, onScan, onRun, onReset }: {
  state: RunState;
  onScan: (address: string) => Promise<number | null>;
  onRun: (p: Profile) => void;
  onReset: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([{ from: "agent", text: "I'm T1000. I find idle stablecoins and decide where they should live. Connect a wallet so I can see what you hold." }]);
  const [address, setAddress] = useState(DEMO_WALLET);
  const [step, setStep] = useState(-1);
  const [profile, setProfile] = useState<Partial<Profile>>({});
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  // Scroll the chat log itself, never the page (on narrow screens the page would scroll the HUD away).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs, state.phase, state.plan, state.verified]);

  const say = (m: Msg) => setMsgs((x) => [...x, m]);

  // ?demo=<profile> auto-plays a scripted run (testing and demo recording). The goal line is part of the script.
  const autoRan = useRef(false);
  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("demo");
    const demo = key ? DEMOS[key] : undefined;
    if (!demo || autoRan.current) return;
    autoRan.current = true;
    (async () => {
      say({ from: "user", text: `Scan ${DEMO_WALLET.slice(0, 6)}…${DEMO_WALLET.slice(-4)}` });
      const idle = await onScan(DEMO_WALLET);
      if (idle != null) say({ from: "agent", text: `I see ${usd(idle)} in idle stablecoins across Base, Avalanche and Robinhood Chain.` });
      for (const s of STEPS) {
        say({ from: "agent", text: s.ask });
        const v = demo[s.key];
        const label = s.options?.find((o) => o.value === v)?.label ?? (s.key === "amountUsd" ? usd(v as number) : String(v || "Skip"));
        say({ from: "user", text: label });
      }
      setStep(STEPS.length);
      say({ from: "agent", text: "Scanning the market. Watch the left side." });
      onRun(demo);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scan() {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { say({ from: "agent", text: "That doesn't look like a wallet address." }); return; }
    say({ from: "user", text: `Scan ${address.slice(0, 6)}…${address.slice(-4)}` });
    const idle = await onScan(address);
    if (idle == null) { say({ from: "agent", text: "I couldn't read that wallet. Try again in a moment." }); return; }
    say({ from: "agent", text: `I see ${usd(idle)} in idle stablecoins across Base, Avalanche and Robinhood Chain.` });
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
      const cap = state.maxRunUsd;
      if (cap && n > cap) { n = cap; notes.push(`This demo caps each run at ${usd(cap)}, so I'll plan ${usd(cap)}.`); }
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
        <button className="chat-reset" onClick={() => { onReset(); setMsgs(msgs.slice(0, 1)); setStep(-1); setProfile({}); }}>Restart</button>
      </div>

      <div className="chat-log" ref={logRef}>
        {msgs.map((m, i) => <div key={i} className={`msg msg-${m.from}`}>{m.text}</div>)}

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
            <button className="btn-approve" disabled title="Execution comes online with the agent wallet executor.">
              {state.plan.verified ? "Approve & execute (executor offline)" : "Not verified: cannot execute"}
            </button>
          </div>
        )}

        {state.phase === "error" && <div className="msg msg-agent msg-error">{state.error}</div>}
      </div>

      <div className="chat-input">
        {step === -1 && (
          <div className="chat-row">
            <input value={address} onChange={(e) => setAddress(e.target.value.trim())} spellCheck={false} aria-label="Wallet address" />
            <button onClick={scan} disabled={state.phase === "scanning_wallet"}>{state.phase === "scanning_wallet" ? "Scanning…" : "Scan wallet"}</button>
          </div>
        )}
        {current && (
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
        {step >= STEPS.length && state.phase !== "done" && state.phase !== "error" && <div className="chat-wait">T1000 is thinking…</div>}
      </div>
    </div>
  );
}
