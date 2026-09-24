"use client";
import { Chat, type GuardActions } from "@/components/Chat";
import { GuardHud } from "@/components/GuardHud";
import { Hud } from "@/components/Hud";
import { Intro, replayIntro } from "@/components/Intro";
import { LiquidScene, rebalanceLegs } from "@/components/LiquidScene";
import { LiquidPreview } from "@/components/LiquidPreview";
import { useState, useSyncExternalStore } from "react";
import { useT1000 } from "@/lib/use-t1000";

const subscribe = () => () => {};
const readPreview = () => {
  const q = new URLSearchParams(window.location.search);
  return q.get("liquid") === "preview" ? (q.get("mode") === "live" ? "live" : "simulate") : null;
};

export default function Home() {
  const t = useT1000();
  const { state } = t;
  const preview = useSyncExternalStore(subscribe, readPreview, () => null);
  // Restart = a fresh visit: clear the run, replay the intro, and remount the chat (a ?demo= script plays again).
  const [take, setTake] = useState(0);
  const restart = () => { t.reset(); replayIntro(); setTake((n) => n + 1); };
  const guardActions: GuardActions = {
    enter: t.enterGuard, scan: () => void t.scanGuard(), setSource: t.setGuardSource, setScenario: t.setScenario,
    feed: t.feed, cancelFeed: t.cancelFeed, propose: () => void t.proposeRebalance(), executeMoves: (m, p) => void t.executeMoves(m, p),
    applyMoves: t.applyMoves, dismiss: t.dismissRebalance, resume: t.resumeGuard,
  };

  const g = state.guard;
  const guardView = !!g && g.feeding == null;
  const moveScene = g?.moves && g.movesFrom && g.rebalance?.plan ? rebalanceLegs(g.movesFrom, g.rebalance.plan.check.executable) : null;

  if (preview) return <main className="liquid-preview"><LiquidPreview mode={preview} /></main>;
  return (
    <>
    <Intro src="/intro/t1000-intro.mp4" poster="/intro/t1000-intro-poster.jpg" />
    <main className="split">
      <section className="split-visual" aria-label="Allocation vision">
        {guardView ? <GuardHud guard={g} /> : <Hud state={state} />}
        {state.execution && state.plan && (
          <div className="liquid-layer">
            <LiquidScene legs={state.plan.legs} execution={state.execution} />
          </div>
        )}
        {g?.moves && moveScene && (
          <div className="liquid-layer">
            <LiquidScene legs={moveScene.to} from={moveScene.from} execution={g.moves} />
          </div>
        )}
      </section>
      <section className="split-chat" aria-label="Agent chat">
        <Chat key={take} state={state} onScan={t.scanWallet} onRun={t.run} onReset={restart} onExecute={t.executePlan} guard={guardActions} />
      </section>
    </main>
    </>
  );
}
