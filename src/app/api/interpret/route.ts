import { z } from "zod";
import { interpret } from "@/lib/interpret";
import { overLimit } from "@/lib/limits";

export const runtime = "nodejs";

const Body = z.object({
  step: z.enum(["residence", "amountUsd", "horizon", "instantAccess", "preference", "risk", "goal"]),
  text: z.string().max(500),
  idleUsd: z.number().nonnegative().default(0),
});

const hits = new Map<string, number[]>(); // per server instance

export async function POST(req: Request) {
  const limited = overLimit(hits, req, 40, "That's a lot of answers in a row. Give it a few minutes.");
  if (limited) return limited;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, message: "Invalid request." }, { status: 400 });
  const { step, text, idleUsd } = parsed.data;
  return Response.json(await interpret(step, text, { idleUsd }));
}
