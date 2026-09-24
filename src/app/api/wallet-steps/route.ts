// "My wallet" mode: turns a signed plan (or a signed Guard move plan) into unsigned transactions for the user's own
// wallet. Re-checks the rulebook against that wallet's live funds and gas, builds the steps for that address, and
// pre-flight-simulates every step from it with its real balances (nothing injected). The server never signs:
// the browser sends each step to the user's wallet, which asks the user to confirm it.
import { encodeFunctionData, type Address } from "viem";
import { z } from "zod";
import { CHAINS, publicLimits, type ChainKey } from "@/lib/config";
import { buildMoveSteps, buildSteps, ixsRedeemMinUsd, simulate, type Step, type StepResult } from "@/lib/execute";
import { guardState } from "@/lib/guard";
import { checkExecutable, checkMoves } from "@/lib/plan-guard";
import { verifyMoves, verifyPlan } from "@/lib/plan-token";
import { AddressSchema, GuardRequestSchema, LegSchema, ProfileSchema } from "@/lib/profile-schema";
import { MOVE_ENDS } from "@/lib/rebalance";
import { eligibility } from "@/lib/rulebook";
import { scanWallet } from "@/lib/scan";
import { getSignals } from "@/lib/signals";

export const runtime = "nodejs";
export const maxDuration = 120;

export type WalletStep = {
  venue: string; chain: ChainKey; chainId: number; label: string; to: Address; data: `0x${string}`;
  /** The allowance this step relies on, so the browser can wait until the approval is visible before sending. */
  spends?: { token: Address; spender: Address; amount: string };
};
export type WalletStepsResponse = { ok: boolean; errors: string[]; steps: WalletStep[]; simulation: StepResult[] };

const PlanBody = z.object({
  kind: z.literal("plan"),
  address: AddressSchema,
  profile: ProfileSchema,
  legs: z.array(LegSchema).min(1).max(4),
  iat: z.number(),
  planToken: z.string().max(128),
});
const MoveSchema = z.object({ from: z.enum(MOVE_ENDS), to: z.enum(MOVE_ENDS), usd: z.number(), bridge_required: z.boolean(), why: z.string() });
const MovesBody = z.object({
  kind: z.literal("moves"),
  address: AddressSchema,
  moves: z.array(MoveSchema).min(1).max(6),
  guard: GuardRequestSchema,
  iat: z.number(),
  planToken: z.string().max(128),
});

function toWalletSteps(steps: Step[]): WalletStep[] {
  return steps.map((s) => ({
    venue: s.venue, chain: s.chain, chainId: CHAINS[s.chain].chain.id, label: s.label, to: s.to,
    data: encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args } as never),
    spends: s.spends ? { token: s.spends.token, spender: s.spends.spender, amount: s.spends.amount.toString() } : undefined,
  }));
}

async function respond(steps: Step[], address: Address): Promise<Response> {
  const simulation = await simulate(steps, address, undefined, { injectBalances: false });
  const failed = simulation.filter((r) => !r.ok);
  const body: WalletStepsResponse = {
    ok: failed.length === 0,
    errors: failed.map((r) => `${r.label}: ${r.detail}`),
    steps: failed.length ? [] : toWalletSteps(steps),
    simulation,
  };
  return Response.json(body);
}

const refuse = (errors: string[], status = 200) => Response.json({ ok: false, errors, steps: [], simulation: [] } satisfies WalletStepsResponse, { status });

export async function POST(req: Request) {
  const limits = publicLimits();
  if (!limits.enabled) return refuse(["Wallet mode is switched off right now. The demo still works."], 403);
  const raw = await req.json().catch(() => null);

  if (raw && typeof raw === "object" && (raw as { kind?: string }).kind === "moves") {
    const p = MovesBody.safeParse(raw);
    if (!p.success) return refuse([p.error.issues[0]?.message ?? "Invalid request."], 400);
    const { address, moves, guard, iat, planToken } = p.data;
    if (guard.address?.toLowerCase() !== address.toLowerCase()) return refuse(["This proposal was made for a different wallet."], 403);
    if (guard.source !== "live" || guard.scenario) return refuse(["Only real positions can be rebalanced, never a scenario."], 403);
    const tokenError = verifyMoves({ moves, source: guard.source, scenario: false, wallet: address }, iat, planToken);
    if (tokenError) return refuse([tokenError], 403);
    const g = await guardState(guard);
    const check = checkMoves(moves, g.positions, g.idleByChain, guard.profile, { ixsRedeemMinUsd: await ixsRedeemMinUsd() });
    const errors = [...check.errors, ...(check.deferred.length ? ["Moves that need a bridge cannot be executed."] : [])];
    if (errors.length) return refuse(errors);
    return respond(await buildMoveSteps(check.executable, address as Address, g.signals.rhEth.priceUsd ?? 0), address as Address);
  }

  const p = PlanBody.safeParse(raw);
  if (!p.success) return refuse([p.error.issues[0]?.message ?? "Invalid request."], 400);
  const { address, profile, legs, iat, planToken } = p.data;
  const tokenError = verifyPlan(profile, legs, iat, planToken, address);
  if (tokenError) return refuse([tokenError], 403);

  // Fresh checks against what the wallet holds right now (it may have changed since the plan was made).
  const [s, scan] = await Promise.all([getSignals(address as Address), scanWallet(address as Address)]);
  const chainFunds: Partial<Record<ChainKey, number>> = {};
  const chainGas: Partial<Record<ChainKey, number>> = {};
  for (const h of scan.holdings) {
    if (h.stable) chainFunds[h.chain] = (chainFunds[h.chain] ?? 0) + h.amount;
    else if (h.symbol !== "WETH") chainGas[h.chain] = (chainGas[h.chain] ?? 0) + h.amount;
  }
  const elig = eligibility(profile, {
    ixs: { paused: s.ixs.paused, whitelistEnabled: s.ixs.whitelistEnabled, agentWhitelisted: s.ixs.agentWhitelisted },
    usMarketOpen: s.market.usMarketOpen,
    chainFunds,
    chainGas,
  });
  const errors = checkExecutable(legs, profile, elig, limits);
  if (errors.length) return refuse(errors);
  return respond(await buildSteps(legs, address as Address), address as Address);
}
