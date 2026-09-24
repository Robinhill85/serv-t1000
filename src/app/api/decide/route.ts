// Streams the think step to the HUD as server-sent events: signals, eligibility, Jev, fast draft, verified decision, plan.
// Body: the profile, plus `wallet` in "My wallet" mode (the plan is then capped by that wallet's funds and gas, and the
// signature binds it to that address). Without `wallet` it is a demo plan, executed only by simulation or the operator.
import type { Address } from "viem";
import { publicLimits } from "@/lib/config";
import { agentAddress } from "@/lib/execute";
import { runPipeline, type PipelineEvent } from "@/lib/pipeline";
import { signPlan } from "@/lib/plan-token";
import { AddressSchema, ProfileSchema } from "@/lib/profile-schema";

export const runtime = "nodejs";
export const maxDuration = 90;

function agent() {
  try { return agentAddress(); } catch { return undefined; }
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid profile." }, { status: 400 });
  const rawWallet = (body as { wallet?: unknown } | null)?.wallet;
  let wallet: Address | undefined;
  if (rawWallet != null) {
    const w = AddressSchema.safeParse(rawWallet);
    if (!w.success) return Response.json({ error: "Invalid wallet address." }, { status: 400 });
    const limits = publicLimits();
    if (!limits.enabled) return Response.json({ error: "Wallet mode is switched off right now. The demo still works." }, { status: 403 });
    if (parsed.data.amountUsd > limits.maxRunUsd) return Response.json({ error: `Wallet runs are capped at $${limits.maxRunUsd} during the beta.` }, { status: 400 });
    wallet = w.data as Address;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: PipelineEvent | { type: "done" }) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      // Verified plans are signed so only plans this server issued can run (unverified or unfundable ones stay unsigned).
      const sendSigned = (e: PipelineEvent) => {
        if (e.type === "plan" && e.verified && e.blocked.length === 0) {
          const { iat, token } = signPlan(parsed.data, e.legs, Date.now(), wallet);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...e, iat, planToken: token })}\n\n`));
        } else send(e);
      };
      try {
        await runPipeline(parsed.data, sendSigned, wallet ? { agent: wallet, fundsFrom: wallet, limits: publicLimits() } : { agent: agent() });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : "Pipeline failed." });
      }
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
