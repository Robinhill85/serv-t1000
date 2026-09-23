import { z } from "zod";
import { interpret } from "@/lib/interpret";

export const runtime = "nodejs";

const Body = z.object({
  step: z.enum(["residence", "amountUsd", "horizon", "instantAccess", "preference", "risk", "goal"]),
  text: z.string().max(500),
  idleUsd: z.number().nonnegative().default(0),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, message: "Invalid request." }, { status: 400 });
  const { step, text, idleUsd } = parsed.data;
  return Response.json(await interpret(step, text, { idleUsd }));
}
