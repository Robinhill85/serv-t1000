import { guardState } from "@/lib/guard";
import { publicError } from "@/lib/public-error";
import { GuardRequestSchema } from "@/lib/profile-schema";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const parsed = GuardRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  try {
    return Response.json(await guardState(parsed.data));
  } catch (e) {
    return Response.json({ error: publicError(e, "Guard scan failed.") }, { status: 502 });
  }
}
