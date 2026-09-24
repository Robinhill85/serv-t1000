// Per-visitor limits for the routes that spend paid model calls (SERV, TypeSafe/Jev). Best effort: counts live in
// one server instance's memory, so they stop casual scripts, not a determined attacker with many IPs.
import { rateAllow } from "./ask-shape";

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
}

/** A 429 once this visitor has made `limit` requests to this route in 10 minutes; null while they're under it. */
export function overLimit(store: Map<string, number[]>, req: Request, limit: number, message: string): Response | null {
  return rateAllow(store, clientIp(req), Date.now(), limit) ? null : Response.json({ ok: false, error: message, message }, { status: 429 });
}
