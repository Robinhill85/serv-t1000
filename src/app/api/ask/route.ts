// "Ask T1000": one question in, a short grounded answer out (SERV Reasoning, fast). Talk only: nothing executes.
// Guards: ASK_ENABLED kill switch, 400-character questions, bounded context, best-effort per-visitor rate limit.
import { z } from "zod";
import { askT1000 } from "@/lib/ask";
import { rateAllow } from "@/lib/ask-shape";

export const runtime = "nodejs";
export const maxDuration = 45;

const Body = z.object({
  question: z.string().trim().min(1).max(400),
  context: z.record(z.string(), z.unknown()).optional(),
});
const hits = new Map<string, number[]>(); // per server instance

export async function POST(req: Request) {
  if (process.env.ASK_ENABLED === "false") return Response.json({ ok: false, error: "Chat is switched off right now." }, { status: 503 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: "Ask a question of up to 400 characters." }, { status: 400 });
  if (JSON.stringify(parsed.data.context ?? {}).length > 8000) return Response.json({ ok: false, error: "Too much context." }, { status: 400 });
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (!rateAllow(hits, ip, Date.now())) return Response.json({ ok: false, error: "That's a lot of questions. Give it a few minutes." }, { status: 429 });

  const r = await askT1000(parsed.data.question, parsed.data.context ?? {});
  if (!r.ok || !r.value) return Response.json({ ok: false, error: "I couldn't answer that just now. Try again in a moment." }, { status: 502 });
  const words = r.value.answer.split(/\s+/);
  const answer = words.length > 110 ? words.slice(0, 110).join(" ") + "…" : r.value.answer; // hard cap on runaway answers
  return Response.json({ ok: true, answer, suggest: r.value.suggest, ms: r.ms });
}
