"use client";
import { Chat } from "@/components/Chat";
import { Hud } from "@/components/Hud";
import { useT1000 } from "@/lib/use-t1000";

export default function Home() {
  const { state, scanWallet, run, reset } = useT1000();
  return (
    <main className="split">
      <section className="split-visual" aria-label="Allocation vision">
        <Hud state={state} />
      </section>
      <section className="split-chat" aria-label="Agent chat">
        <Chat state={state} onScan={scanWallet} onRun={run} onReset={reset} />
      </section>
    </main>
  );
}
