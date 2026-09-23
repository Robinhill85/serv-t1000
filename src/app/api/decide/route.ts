// Streams the think step to the HUD as server-sent events: signals, eligibility, Jev, fast draft, verified decision, plan.
import { agentAddress } from "@/lib/execute";
import { runPipeline, type PipelineEvent } from "@/lib/pipeline";
import { signPlan } from "@/lib/plan-token";
import { ProfileSchema } from "@/lib/profile-schema";

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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: PipelineEvent | { type: "done" }) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      // Verified plans are signed so /api/execute only runs plans this server issued (unverified ones stay unsigned).
      const sendSigned = (e: PipelineEvent) => {
        if (e.type === "plan" && e.verified) {
          const { iat, token } = signPlan(parsed.data, e.legs);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...e, iat, planToken: token })}\n\n`));
        } else send(e);
      };
      try {
        await runPipeline(parsed.data, sendSigned, { agent: agent() });
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
