"use client";
import { Chat } from "@/components/Chat";
import { Hud } from "@/components/Hud";
import { Intro } from "@/components/Intro";
import { useT1000 } from "@/lib/use-t1000";

export default function Home() {
  const { state, scanWallet, run, reset, executePlan } = useT1000();
  return (
    <>
    <Intro src="/intro/t1000-intro.mp4" poster="/intro/t1000-intro-poster.jpg" />
    <main className="split">
      <section className="split-visual" aria-label="Allocation vision">
        <Hud state={state} />
      </section>
      <section className="split-chat" aria-label="Agent chat">
        <Chat state={state} onScan={scanWallet} onRun={run} onReset={reset} onExecute={executePlan} />
      </section>
    </main>
    </>
  );
}
