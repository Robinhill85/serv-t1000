// "My wallet" mode: turns a signed plan (or a signed Guard move plan) into unsigned transactions for the user's own
// wallet. Re-checks the rulebook against that wallet's live funds and gas, builds the steps for that address, and
// pre-flight-simulates every step from it with its real balances (nothing injected). The server never signs:
// the browser sends each step to the user's wallet, which asks the user to confirm it.
//
// Waterproofing (24 Sep): every step has a stable key (base:deposit, rh_eth:buy...). `skip` lists keys already
// confirmed onchain, so "Finish the remaining steps" never repeats a deposit. `only` rebuilds and re-simulates one
// step right before the wallet signs it: a fresh swap quote (1% slippage for wallet runs) and a last check.
// kind "withdraw" builds full exits from positions the wallet holds (no plan needed: funds only go back to it).
import { KNOWN_VAULTS } from "@ixswap1/vault-agent-sdk";
import { encodeFunctionData, formatUnits, type Address } from "viem";
import { z } from "zod";
import { CHAINS, publicLimits, TOKENS, UNISWAP_RH, VENUES, type ChainKey, type VenueId } from "@/lib/config";
import { buildExitSteps, buildMoveSteps, buildSteps, ixsRedeemMinUsd, simulate, type Step, type StepResult } from "@/lib/execute";
import { guardState } from "@/lib/guard";
import { checkExecutable, checkMoves } from "@/lib/plan-guard";
import { verifyMoves, verifyPlan } from "@/lib/plan-token";
import { AddressSchema, GuardRequestSchema, LegSchema, ProfileSchema } from "@/lib/profile-schema";
import { MOVE_ENDS } from "@/lib/rebalance";
import { LEG_DONE_KEY, moveDoneKey } from "@/lib/step-keys";
import { eligibility } from "@/lib/rulebook";
import { erc20Abi, publicClient } from "@/lib/clients";
import { scanWallet } from "@/lib/scan";
import { getSignals } from "@/lib/signals";

export const runtime = "nodejs";
export const maxDuration = 120;

export type WalletStep = {
  /** Stable id within the run (venue:action): resume and per-step re-checks go by it. */
  key: string;
  venue: string; chain: ChainKey; chainId: number; label: string; to: Address; data: `0x${string}`;
  /** The allowance this step relies on, so the browser can wait until the approval is visible before sending. */
  spends?: { token: Address; spender: Address; amount: string };
  /** What the user is about to sign, in plain words (wallets can mislabel approvals). */
  explain: string;
  /** Gas limit (hex): the pre-flight estimate + 30%. Wallets otherwise use the bare estimate, and a Morpho deposit
   *  ran out at exactly its estimate on Robin's first real run (24 Sep). */
  gas?: `0x${string}`;
};
export type WalletStepsResponse = { ok: boolean; errors: string[]; steps: WalletStep[]; simulation: StepResult[]; notes?: string[] };
/** Reply to an `only` request: the fresh step to sign now, or skip (an approval already in place). */
export type WalletStepPrepare = { ok: boolean; skip?: boolean; step?: WalletStep; error?: string };

/** Wallet runs: 1% slippage on swaps (a person can take a minute to confirm). The agent path keeps 0.5%. */
const WALLET_OPTS = { slippageBps: 100n };


const Resume = {
  /** Keys already confirmed onchain in this run. */
  skip: z.array(z.string().max(40)).max(12).optional(),
  /** Rebuild and re-simulate just this step, right before the wallet signs it. */
  only: z.string().max(40).optional(),
};
const PlanBody = z.object({
  kind: z.literal("plan"),
  ...Resume,
  address: AddressSchema,
  profile: ProfileSchema,
  legs: z.array(LegSchema).min(1).max(4),
  iat: z.number(),
  planToken: z.string().max(128),
});
const MoveSchema = z.object({ from: z.enum(MOVE_ENDS), to: z.enum(MOVE_ENDS), usd: z.number(), bridge_required: z.boolean(), why: z.string() });
const MovesBody = z.object({
  kind: z.literal("moves"),
  ...Resume,
  address: AddressSchema,
  moves: z.array(MoveSchema).min(1).max(6),
  guard: GuardRequestSchema,
  iat: z.number(),
  planToken: z.string().max(128),
});

const WithdrawBody = z.object({
  kind: z.literal("withdraw"),
  ...Resume,
  address: AddressSchema,
  venues: z.array(z.enum(["base", "ixs", "rh_eth"])).min(1).max(3),
});

const TOKEN_INFO: Record<string, { symbol: string; decimals: number }> = {
  [TOKENS.base.USDC.toLowerCase()]: { symbol: "USDC", decimals: 6 },
  [TOKENS.avalanche.USDC.toLowerCase()]: { symbol: "USDC", decimals: 6 },
  [TOKENS.robinhood.USDG.toLowerCase()]: { symbol: "USDG", decimals: 6 },
  [TOKENS.robinhood.WETH.toLowerCase()]: { symbol: "WETH", decimals: 18 },
};
const SPENDER_NAME: Record<string, string> = {
  [VENUES.base.address!.toLowerCase()]: "Gauntlet USDC Prime (Morpho)",
  [KNOWN_VAULTS["avax-ixhyb"].address.toLowerCase()]: "the IXS vault",
  [UNISWAP_RH.swapRouter02.toLowerCase()]: "the Uniswap router",
};

/** Plain words for what the user signs. MetaMask can show a USDC approval as an "NFT withdrawal request". */
function explain(s: Step): string {
  if (s.functionName === "approve") {
    const [spender, amount] = s.args as [Address, bigint];
    const t = TOKEN_INFO[s.to.toLowerCase()];
    const amt = t ? `${Number(formatUnits(amount, t.decimals)).toFixed(t.decimals === 18 ? 6 : 2)} ${t.symbol}` : amount.toString();
    return `Lets ${SPENDER_NAME[spender.toLowerCase()] ?? spender} use exactly ${amt}. Nothing moves yet. Some wallets (MetaMask) label this an "NFT withdrawal request": it is a ${t?.symbol ?? "token"} spending cap.`;
  }
  if (s.functionName === "deposit") return "Deposits into Gauntlet USDC Prime on Morpho. You get vault shares and can withdraw any time.";
  if (s.functionName === "requestDeposit") return "Requests a deposit into the IXS vault. It settles T+1; if IXS rejects it, the USDC comes back.";
  if (s.functionName === "exactInputSingle") return "Swaps on Uniswap v3 with a slippage floor; the minimum you receive is in the step name.";
  if (s.functionName === "withdraw") return "Withdraws from Gauntlet USDC Prime back to your wallet.";
  if (s.functionName === "redeem") return "Redeems all your Gauntlet USDC Prime shares: the USDC plus interest goes back to your wallet.";
  if (s.functionName === "requestRedeem") return "Requests an exit from the IXS vault: settles T+1, 0.5% fee.";
  return s.label;
}

const withHeadroom = (gas?: string): `0x${string}` | undefined => (gas ? `0x${((BigInt(gas) * 13n) / 10n + 20_000n).toString(16)}` : undefined);

function toWalletSteps(steps: Step[], sim: StepResult[]): WalletStep[] {
  return steps.map((s, i) => ({
    key: s.key ?? `${s.venue}:${i}`,
    explain: explain(s),
    gas: withHeadroom(sim[i]?.gas),
    venue: s.venue, chain: s.chain, chainId: CHAINS[s.chain].chain.id, label: s.label, to: s.to,
    data: encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args } as never),
    spends: s.spends ? { token: s.spends.token, spender: s.spends.spender, amount: s.spends.amount.toString() } : undefined,
  }));
}

/** Drops approvals the wallet already has in place (e.g. a retry after a failed deposit): one transaction fewer. */
async function skipSatisfiedApprovals(steps: Step[], owner: Address): Promise<Step[]> {
  const keep = await Promise.all(steps.map(async (s) => {
    if (s.functionName !== "approve") return true;
    const [spender, amount] = s.args as [Address, bigint];
    const have = await publicClient(s.chain).readContract({ address: s.to, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }).catch(() => 0n);
    return have < amount;
  }));
  return steps.filter((_, i) => keep[i]);
}

async function respond(allSteps: Step[], address: Address, skip: string[] = [], notes?: string[]): Promise<Response> {
  const steps = await skipSatisfiedApprovals(allSteps.filter((s) => !s.key || !skip.includes(s.key)), address);
  const simulation = await simulate(steps, address, undefined, { injectBalances: false });
  const failed = simulation.filter((r) => !r.ok);
  const body: WalletStepsResponse = {
    ok: failed.length === 0,
    errors: failed.map((r) => `${r.label}: ${r.detail}`),
    steps: failed.length ? [] : toWalletSteps(steps, simulation),
    simulation,
    notes,
  };
  return Response.json(body);
}

/** One step, rebuilt fresh and re-simulated from the wallet just before it signs. */
async function prepareOne(allSteps: Step[], key: string, address: Address): Promise<Response> {
  const s = allSteps.find((x) => x.key === key);
  if (!s) return Response.json({ ok: false, error: "This step is no longer needed or no longer possible. Nothing was sent." } satisfies WalletStepPrepare);
  if ((await skipSatisfiedApprovals([s], address)).length === 0) return Response.json({ ok: true, skip: true } satisfies WalletStepPrepare);
  const [r] = await simulate([s], address, undefined, { injectBalances: false });
  if (!r?.ok) return Response.json({ ok: false, error: `Stopped before sending: this step would fail from your wallet right now (${r?.detail ?? "no result"}). Nothing was sent for it.` } satisfies WalletStepPrepare);
  return Response.json({ ok: true, step: toWalletSteps([s], [r])[0] } satisfies WalletStepPrepare);
}

const refuse = (errors: string[], status = 200) => Response.json({ ok: false, errors, steps: [], simulation: [] } satisfies WalletStepsResponse, { status });

export async function POST(req: Request) {
  const limits = publicLimits();
  if (!limits.enabled) return refuse(["Wallet mode is switched off right now. The demo still works."], 403);
  const raw = await req.json().catch(() => null);
  const kind = raw && typeof raw === "object" ? (raw as { kind?: string }).kind : undefined;

  if (kind === "withdraw") {
    const p = WithdrawBody.safeParse(raw);
    if (!p.success) return refuse([p.error.issues[0]?.message ?? "Invalid request."], 400);
    const { address, venues, skip = [], only } = p.data;
    // Sized from what the wallet holds right now, so a finished exit simply drops out on a retry.
    const { steps, notes } = await buildExitSteps(venues, address as Address, WALLET_OPTS);
    if (only) return prepareOne(steps, only, address as Address);
    if (!steps.filter((s) => !s.key || !skip.includes(s.key)).length) return Response.json({ ok: true, errors: [], steps: [], simulation: [], notes } satisfies WalletStepsResponse);
    return respond(steps, address as Address, skip, notes);
  }

  if (kind === "moves") {
    const p = MovesBody.safeParse(raw);
    if (!p.success) return refuse([p.error.issues[0]?.message ?? "Invalid request."], 400);
    const { address, moves, guard, iat, planToken, skip = [], only } = p.data;
    if (guard.address?.toLowerCase() !== address.toLowerCase()) return refuse(["This proposal was made for a different wallet."], 403);
    if (guard.source !== "live" || guard.scenario) return refuse(["Only real positions can be rebalanced, never a scenario."], 403);
    const tokenError = verifyMoves({ moves, source: guard.source, scenario: false, wallet: address }, iat, planToken);
    if (tokenError) return refuse([tokenError], 403);
    // Moves already confirmed are left out: each is same-chain and independent, so the rest are checked on their own.
    const open = moves.filter((m) => !skip.includes(moveDoneKey(m)));
    const g = await guardState(guard);
    if (only) {
      const m = open.find((x) => x.from === only.split(":")[0] || x.to === only.split(":")[0]);
      if (!m) return Response.json({ ok: false, error: "This step is not part of the signed moves." } satisfies WalletStepPrepare);
      return prepareOne(await buildMoveSteps([m], address as Address, g.signals.rhEth.priceUsd ?? 0, WALLET_OPTS), only, address as Address);
    }
    if (!open.length) return Response.json({ ok: true, errors: [], steps: [], simulation: [] } satisfies WalletStepsResponse);
    const check = checkMoves(open, g.positions, g.idleByChain, guard.profile, { ixsRedeemMinUsd: await ixsRedeemMinUsd() });
    const errors = [...check.errors, ...(check.deferred.length ? ["Moves that need a bridge cannot be executed."] : [])];
    if (errors.length) return refuse(errors);
    return respond(await buildMoveSteps(check.executable, address as Address, g.signals.rhEth.priceUsd ?? 0, WALLET_OPTS), address as Address, skip);
  }

  const p = PlanBody.safeParse(raw);
  if (!p.success) return refuse([p.error.issues[0]?.message ?? "Invalid request."], 400);
  const { address, profile, legs, iat, planToken, skip = [], only } = p.data;
  const tokenError = verifyPlan(profile, legs, iat, planToken, address);
  if (tokenError) return refuse([tokenError], 403);
  const done = (l: { venue: VenueId }) => skip.includes(LEG_DONE_KEY[l.venue]);
  if (only) {
    // The plan was checked in full when the run started; this rebuilds one step with a fresh quote and re-simulates it.
    const leg = legs.find((l) => l.venue === only.split(":")[0] && !done(l));
    if (!leg) return Response.json({ ok: false, error: "This step is not part of the signed plan, or it already ran." } satisfies WalletStepPrepare);
    return prepareOne(await buildSteps([leg], address as Address, WALLET_OPTS), only, address as Address);
  }
  if (legs.every(done)) return Response.json({ ok: true, errors: [], steps: [], simulation: [] } satisfies WalletStepsResponse);

  // Fresh checks against what the wallet holds right now (it may have changed since the plan was made).
  const [s, scan] = await Promise.all([getSignals(address as Address), scanWallet(address as Address)]);
  const chainFunds: Partial<Record<ChainKey, number>> = {};
  const chainGas: Partial<Record<ChainKey, number>> = {};
  for (const h of scan.holdings) {
    if (h.stable) chainFunds[h.chain] = (chainFunds[h.chain] ?? 0) + h.amount;
    else if (h.symbol !== "WETH") chainGas[h.chain] = (chainGas[h.chain] ?? 0) + h.amount;
  }
  // A resumed run: legs already deposited spent their funds, so the plan is checked as if they were still there.
  for (const l of legs.filter(done)) { const c = VENUES[l.venue].chain as ChainKey; chainFunds[c] = (chainFunds[c] ?? 0) + l.usd; }
  const elig = eligibility(profile, {
    ixs: { paused: s.ixs.paused, whitelistEnabled: s.ixs.whitelistEnabled, agentWhitelisted: s.ixs.agentWhitelisted },
    usMarketOpen: s.market.usMarketOpen,
    chainFunds,
    chainGas,
  });
  const errors = checkExecutable(legs, profile, elig, limits);
  if (errors.length) return refuse(errors);
  return respond(await buildSteps(legs.filter((l) => !done(l)), address as Address, WALLET_OPTS), address as Address, skip);
}
