// Runs a signed plan. mode "simulate" (anyone): builds and eth_call-simulates every transaction, nothing is sent.
// mode "live": also requires EXECUTION_ENABLED=true and the LIVE_PASSCODE, then sends through the agent wallet.
// Both modes re-check the plan against fresh signals and the rulebook first.
import { z } from "zod";
import { executionLimits } from "@/lib/config";
import { agentAccount, buildSteps, execute, simulate, type StepResult } from "@/lib/execute";
import { checkExecutable } from "@/lib/plan-guard";
import { passcodeOk, verifyPlan } from "@/lib/plan-token";
import { ProfileSchema } from "@/lib/profile-schema";
import { eligibility } from "@/lib/rulebook";
import { getSignals } from "@/lib/signals";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
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

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { mode, profile, legs, iat, planToken, passcode } = parsed.data;

  const tokenError = verifyPlan(profile, legs, iat, planToken);
  if (tokenError) return Response.json({ error: tokenError }, { status: 403 });

  const limits = executionLimits();
  if (mode === "live") {
    if (!process.env.LIVE_PASSCODE) return Response.json({ error: "Live runs are not configured on this deployment." }, { status: 403 });
    if (!passcodeOk(passcode)) return Response.json({ error: "Wrong passcode. Live runs are for the operator; anyone can run a simulation." }, { status: 403 });
    if (!limits.enabled) return Response.json({ error: "Execution is switched off (kill switch)." }, { status: 403 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ExecuteEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        const agent = agentAccount().address;
        const s = await getSignals(agent);
        const elig = eligibility(profile, {
          ixs: { paused: s.ixs.paused, whitelistEnabled: s.ixs.whitelistEnabled, agentWhitelisted: s.ixs.agentWhitelisted },
          usMarketOpen: s.market.usMarketOpen,
        });
        // Simulation is allowed with the kill switch off; every other rule applies to both modes.
        const errors = checkExecutable(legs, profile, elig, { ...limits, enabled: mode === "simulate" ? true : limits.enabled });
        send({ type: "checks", errors });
        if (errors.length) { send({ type: "done", mode, ok: false }); controller.close(); return; }

        const steps = await buildSteps(legs, agent);
        send({ type: "steps", steps: steps.map((x) => ({ venue: x.venue, chain: x.chain, label: x.label })) });
        let results: StepResult[];
        if (mode === "simulate") {
          results = await simulate(steps, agent);
          for (const r of results) send({ type: "step", result: r });
        } else {
          results = await execute(steps, (r) => send({ type: "step", result: r }));
        }
        send({ type: "done", mode, ok: results.length === steps.length && results.every((r) => r.ok) });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message.slice(0, 300) : "Execution failed." });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
}
