"use client";
// ?liquid=preview (optionally &mode=live): the vault scene alone, driven by a scripted mock run.
// For iterating on the visuals and for clean video takes; real runs use the same component with live data.
import { useEffect, useState } from "react";
import type { Leg } from "@/lib/types";
import type { Execution, StepView } from "@/lib/use-t1000";
import { LiquidScene } from "./LiquidScene";

const LEGS: Leg[] = [
  { venue: "ixs", pct: 67, usd: 100.5 },
  { venue: "base", pct: 20, usd: 30 },
  { venue: "rh_eth", pct: 13, usd: 19.5 },
];
const STEPS: StepView[] = [
  { venue: "ixs", chain: "avalanche", label: "Approve USDC for the IXS vault" },
  { venue: "ixs", chain: "avalanche", label: "Request deposit into the IXS vault" },
  { venue: "base", chain: "base", label: "Approve USDC for the Morpho vault" },
  { venue: "base", chain: "base", label: "Deposit USDC into Gauntlet USDC Prime" },
  { venue: "rh_eth", chain: "robinhood", label: "Approve USDG for the Uniswap router" },
  { venue: "rh_eth", chain: "robinhood", label: "Swap USDG for ETH" },
];

export function LiquidPreview({ mode }: { mode: "simulate" | "live" }) {
  const [done, setDone] = useState(0);
  useEffect(() => {
    // One run, then hold the final state (a clean take for the video). Starts after a short beat.
    const id = setInterval(() => setDone((d) => Math.min(STEPS.length, d + 1)), 1400);
    return () => clearInterval(id);
  }, []);
  const execution: Execution = {
    mode,
    status: done >= STEPS.length ? "done" : "running",
    checks: [],
    steps: STEPS.map((s, i) => (i < done ? { ...s, ok: true, detail: "ok" } : s)),
  };
  return <LiquidScene legs={LEGS} execution={execution} />;
}
