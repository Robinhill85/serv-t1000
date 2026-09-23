// Guard mode: re-reads positions and triggers on the server, asks SERV for moves (fast draft, then verified),
// checks them in code, and streams a signed move plan. Executable moves are same-chain only.
import { ixsRedeemMinUsd } from "@/lib/execute";
import { guardState } from "@/lib/guard";
import { checkMoves } from "@/lib/plan-guard";
import { signMoves } from "@/lib/plan-token";
import { GuardRequestSchema } from "@/lib/profile-schema";
import { decideRebalance, rebalanceInput } from "@/lib/rebalance";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(req: Request) {
  const parsed = GuardRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const body = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        const g = await guardState(body);
        send({ type: "guard", guard: g });
        const actionable = g.triggers.filter((t) => t.code !== "NEW_CASH");
        if (!actionable.length) {
          send({ type: "error", message: "No rebalance trigger is active." });
        } else {
          const input = rebalanceInput({ profile: body.profile, targets: g.targets, positions: g.positions, triggers: actionable, signals: g.signals, idleByChain: g.idleByChain, scenario: body.scenario });
          const fast = await decideRebalance(input, "fast");
          send({ type: "rebalance_fast", result: fast });
          const verified = await decideRebalance(input, "verified", fast.value ?? undefined);
          send({ type: "rebalance_verified", result: verified });
          const decision = verified.value ?? fast.value;
          if (!decision) {
            send({ type: "error", message: verified.error ?? fast.error ?? "SERV returned no proposal." });
          } else {
            const check = checkMoves(decision.moves, g.positions, g.idleByChain, body.profile, { ixsRedeemMinUsd: await ixsRedeemMinUsd() });
            const signable = check.errors.length === 0 && check.executable.length > 0 && !!verified.value;
            const signed = signable ? signMoves({ moves: check.executable, source: body.source, scenario: !!body.scenario }) : null;
            send({ type: "move_plan", summary: decision.summary, moves: decision.moves, check, verified: !!verified.value, iat: signed?.iat, planToken: signed?.token });
          }
        }
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message.slice(0, 300) : "Rebalance failed." });
      }
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
}
