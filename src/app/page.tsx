"use client";
import { Chat } from "@/components/Chat";
import { Hud } from "@/components/Hud";
import { Intro } from "@/components/Intro";
import { LiquidScene } from "@/components/LiquidScene";
import { LiquidPreview } from "@/components/LiquidPreview";
import { useSyncExternalStore } from "react";
import { useT1000 } from "@/lib/use-t1000";

const subscribe = () => () => {};
const readPreview = () => {
  const q = new URLSearchParams(window.location.search);
  return q.get("liquid") === "preview" ? (q.get("mode") === "live" ? "live" : "simulate") : null;
};

export default function Home() {
  const { state, scanWallet, run, reset, executePlan } = useT1000();
  const preview = useSyncExternalStore(subscribe, readPreview, () => null);
  if (preview) return <main className="liquid-preview"><LiquidPreview mode={preview} /></main>;
  return (
    <>
    <Intro src="/intro/t1000-intro.mp4" poster="/intro/t1000-intro-poster.jpg" />
    <main className="split">
      <section className="split-visual" aria-label="Allocation vision">
        <Hud state={state} />
        {state.execution && state.plan && (
          <div className="liquid-layer">
            <LiquidScene legs={state.plan.legs} execution={state.execution} />
          </div>
        )}
      </section>
      <section className="split-chat" aria-label="Agent chat">
        <Chat state={state} onScan={scanWallet} onRun={run} onReset={reset} onExecute={executePlan} />
      </section>
    </main>
    </>
  );
}
