// Wallet-run failures reported by the browser, so they show up in the server logs (Vercel) instead of only in the
// visitor's console. No personal data: addresses and transaction hashes are stripped before logging.
import { z } from "zod";
import { rateAllow } from "@/lib/ask-shape";
import { clientIp } from "@/lib/limits";

export const runtime = "nodejs";

const Body = z.object({
  where: z.string().max(40),
  venue: z.string().max(20).optional(),
  chain: z.string().max(20).optional(),
  label: z.string().max(160).optional(),
  detail: z.string().max(600),
});
const hits = new Map<string, number[]>();
const scrub = (t?: string) => t?.replace(/0x[0-9a-fA-F]{64}/g, "0x<hash>").replace(/0x[0-9a-fA-F]{40}/g, "0x<addr>");

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return new Response(null, { status: 400 });
  if (!rateAllow(hits, clientIp(req), Date.now(), 30)) return new Response(null, { status: 429 });
  const { where, venue, chain, label, detail } = p.data;
  console.warn("[wallet-run]", JSON.stringify({ where, venue, chain, label: scrub(label), detail: scrub(detail) }));
  return new Response(null, { status: 204 });
}
