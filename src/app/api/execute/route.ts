// Runs a signed plan. mode "simulate" (anyone): builds and eth_call-simulates every transaction, nothing is sent.
// mode "live": also requires EXECUTION_ENABLED=true and the LIVE_PASSCODE, then sends through the agent wallet.
// Both modes re-check the plan against fresh signals and the rulebook first.
import { z } from "zod";
import { executionLimits, type ChainKey } from "@/lib/config";
import { agentAddress, buildMoveSteps, buildSteps, execute, ixsRedeemMinUsd, simulate, type Step, type StepResult } from "@/lib/execute";
import { guardState } from "@/lib/guard";
import { checkExecutable, checkMoves } from "@/lib/plan-guard";
import { passcodeOk, verifyMoves, verifyPlan } from "@/lib/plan-token";
import { GuardRequestSchema, ProfileSchema } from "@/lib/profile-schema";
import { MOVE_ENDS } from "@/lib/rebalance";
import { eligibility } from "@/lib/rulebook";
import { publicError } from "@/lib/public-error";
import { scanWallet } from "@/lib/scan";
import { getSignals } from "@/lib/signals";

export const runtime = "nodejs";
export const maxDuration = 300;

const MoveSchema = z.object({ from: z.enum(MOVE_ENDS), to: z.enum(MOVE_ENDS), usd: z.number(), bridge_required: z.boolean(), why: z.string() });
const MovesBody = z.object({
  kind: z.literal("moves"),
  mode: z.enum(["simulate", "live"]),
  moves: z.array(MoveSchema).min(1).max(6),
  guard: GuardRequestSchema,
  iat: z.number(),
  planToken: z.string().max(128),
  passcode: z.string().max(200).optional(),
});

const Body = z.object({
  kind: z.literal("plan").default("plan"),
  mode: z.enum(["simulate", "live"]),
  profile: ProfileSchema,
  legs: z.array(z.object({ venue: z.enum(["ixs", "base", "rh_eth", "rh_stocks"]), pct: z.number().int(), usd: z.number() })).min(1).max(4),
  iat: z.number(),
  planToken: z.string().max(128),
  passcode: z.string().max(200).optional(),
});

export type ExecuteEvent =
  | { type: "checks"; errors: string[] }
  | { type: "steps"; steps: { venue: string; chain: string; label: string }[] }
  | { type: "step"; result: StepResult }
  | { type: "done"; mode: "simulate" | "live"; ok: boolean }
  | { type: "error"; message: string };

function stream(run: (send: (e: ExecuteEvent) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (e: ExecuteEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try { await run(send); } catch (err) { send({ type: "error", message: publicError(err, "Execution failed.") }); }
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
}

/** Simulate for anyone; live sends only after a clean pre-flight simulation of every step. */
async function runSteps(steps: Step[], agent: `0x${string}`, mode: "simulate" | "live", send: (e: ExecuteEvent) => void) {
  send({ type: "steps", steps: steps.map((x) => ({ venue: x.venue, chain: x.chain, label: x.label })) });
  if (mode === "simulate") {
    // Demo simulations top up balances the agent wallet lacks (and say so); the live pre-flight below never does.
    const results = await simulate(steps, agent, (r) => send({ type: "step", result: r }), { injectBalances: true });
    send({ type: "done", mode, ok: results.every((r) => r.ok) });
    return;
  }
  const dry = await simulate(steps, agent);
  const bad = dry.filter((r) => !r.ok);
  if (bad.length) {
    send({ type: "error", message: `Pre-flight simulation failed, nothing was sent: ${bad[0].label}: ${bad[0].detail}` });
    send({ type: "done", mode, ok: false });
    return;
  }
  const results = await execute(steps, (r) => send({ type: "step", result: r }));
  send({ type: "done", mode, ok: results.length === steps.length && results.every((r) => r.ok) });
}

function liveGate(passcode: string | undefined): string | null {
  if (!process.env.LIVE_PASSCODE || !process.env.AGENT_PRIVATE_KEY) return "Live runs are not configured on this deployment.";
  if (!passcodeOk(passcode)) return "Wrong passcode. Live runs are for the operator; anyone can run a simulation.";
  if (!executionLimits().enabled) return "Execution is switched off (kill switch).";
  return null;
}

async function postMoves(body: z.infer<typeof MovesBody>) {
  const { mode, moves, guard, iat, planToken, passcode } = body;
  if (guard.address) return Response.json({ error: "Moves for your own wallet are signed in your wallet (/api/wallet-steps)." }, { status: 400 });
  const tokenError = verifyMoves({ moves, source: guard.source, scenario: !!guard.scenario }, iat, planToken);
  if (tokenError) return Response.json({ error: tokenError }, { status: 403 });
  if (mode === "live") {
    const gate = liveGate(passcode);
    if (gate) return Response.json({ error: gate }, { status: 403 });
    if (guard.source !== "live" || guard.scenario) return Response.json({ error: "Live rebalances only run on real positions, never on a scenario." }, { status: 403 });
  }
  return stream(async (send) => {
    const agent = agentAddress();
    const g = await guardState(guard);
    const check = checkMoves(moves, g.positions, g.idleByChain, guard.profile, { ixsRedeemMinUsd: await ixsRedeemMinUsd() });
    const errors = [...check.errors, ...(check.deferred.length ? ["Moves that need a bridge cannot be executed."] : [])];
    send({ type: "checks", errors });
    if (errors.length) { send({ type: "done", mode, ok: false }); return; }
    const steps = await buildMoveSteps(check.executable, agent, g.signals.rhEth.priceUsd ?? 0);
    await runSteps(steps, agent, mode, send);
  });
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  if (raw && typeof raw === "object" && (raw as { kind?: string }).kind === "moves") {
    const mv = MovesBody.safeParse(raw);
    if (!mv.success) return Response.json({ error: mv.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
    return postMoves(mv.data);
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { mode, profile, legs, iat, planToken, passcode } = parsed.data;

  const tokenError = verifyPlan(profile, legs, iat, planToken);
  if (tokenError) return Response.json({ error: tokenError }, { status: 403 });

  const limits = executionLimits();
  if (mode === "live") {
    const gate = liveGate(passcode);
    if (gate) return Response.json({ error: gate }, { status: 403 });
  }

  return stream(async (send) => {
    const agent = agentAddress();
    const s = await getSignals(agent);
    // Live: each leg must fit what the agent wallet holds on its chain (demo plans are planned uncapped).
    let chainFunds: Partial<Record<ChainKey, number>> | undefined;
    if (mode === "live") {
      chainFunds = {};
      for (const h of (await scanWallet(agent)).holdings) if (h.stable) chainFunds[h.chain] = (chainFunds[h.chain] ?? 0) + h.amount;
    }
    const elig = eligibility(profile, {
      ixs: { paused: s.ixs.paused, whitelistEnabled: s.ixs.whitelistEnabled, agentWhitelisted: s.ixs.agentWhitelisted },
      usMarketOpen: s.market.usMarketOpen,
      chainFunds,
    });
    // Simulation is allowed with the kill switch off; every other rule applies to both modes.
    const errors = checkExecutable(legs, profile, elig, { ...limits, enabled: mode === "simulate" ? true : limits.enabled });
    send({ type: "checks", errors });
    if (errors.length) { send({ type: "done", mode, ok: false }); return; }
    await runSteps(await buildSteps(legs, agent), agent, mode, send);
  });
}
