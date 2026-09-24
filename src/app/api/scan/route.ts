import type { Address } from "viem";
import { AddressSchema } from "@/lib/profile-schema";
import { executionLimits, publicLimits } from "@/lib/config";
import { idleStablesUsd, scanWallet } from "@/lib/scan";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const parsed = AddressSchema.safeParse(new URL(req.url).searchParams.get("address"));
  if (!parsed.success) return Response.json({ error: "Pass a valid 0x address." }, { status: 400 });
  const { holdings, errors } = await scanWallet(parsed.data as Address);
  const pub = publicLimits();
  return Response.json({ holdings, idleStablesUsd: idleStablesUsd(holdings), maxRunUsd: executionLimits().maxRunUsd, walletMaxRunUsd: pub.maxRunUsd, walletEnabled: pub.enabled, errors });
}
