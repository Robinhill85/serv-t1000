// A wallet's T1000 positions, read onchain (Base lending shares, IXS shares and pending deposits, WETH on Robinhood
// Chain). Lets a returning visitor see and withdraw what they deployed, from any browser. Read-only.
import type { Address } from "viem";
import { AddressSchema } from "@/lib/profile-schema";
import { readAgentPositions } from "@/lib/positions";
import { getSignals } from "@/lib/signals";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const parsed = AddressSchema.safeParse(new URL(req.url).searchParams.get("address"));
  if (!parsed.success) return Response.json({ error: "Pass a valid 0x address." }, { status: 400 });
  const address = parsed.data as Address;
  try {
    const s = await getSignals(address);
    const { positions } = await readAgentPositions(address, s);
    return Response.json({ positions, at: Date.now() });
  } catch (e) {
    console.error("positions read failed", e instanceof Error ? e.message : e);
    return Response.json({ error: "Couldn't read your positions just now." }, { status: 502 });
  }
}
