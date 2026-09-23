// Streams the think step to the HUD as server-sent events: signals, eligibility, Jev, fast draft, verified decision, plan.
import { privateKeyToAccount } from "viem/accounts";
import { runPipeline, type PipelineEvent } from "@/lib/pipeline";
import { ProfileSchema } from "@/lib/profile-schema";

export const runtime = "nodejs";
export const maxDuration = 90;

function agentAddress() {
  const pk = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;
  return pk ? privateKeyToAccount(pk).address : undefined;
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
      try {
        await runPipeline(parsed.data, send, { agent: agentAddress() });
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
