// Dry run of the executor: builds every leg's transactions and simulates them. Sends nothing.
// `npx tsx --env-file=.env.local scripts/simulate.mts [ixs=100.5] [base=30] [rh_eth=19.5]`
import { agentAccount, buildSteps, simulate } from "../src/lib/execute.ts";
import type { Leg } from "../src/lib/types.ts";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")));
const amounts: Record<string, number> = { ixs: Number(args.ixs ?? 100.5), base: Number(args.base ?? 30), rh_eth: Number(args.rh_eth ?? 19.5) };
const total = Object.values(amounts).reduce((a, b) => a + b, 0);
const legs = Object.entries(amounts).filter(([, v]) => v > 0).map(([venue, usd]) => ({ venue, usd, pct: Math.round((usd / total) * 100) })) as Leg[];
const agent = agentAccount().address;
console.log(`agent ${agent}, legs ${JSON.stringify(legs)}`);
const steps = await buildSteps(legs, agent);
for (const r of await simulate(steps, agent, undefined, { injectBalances: true })) console.log(`${r.ok ? "OK  " : "FAIL"} [${r.chain}] ${r.label}: ${r.detail}`);

// Guard-mode moves: `npx tsx --env-file=.env.local scripts/simulate.mts moves`
if (process.argv.includes("moves")) {
  const { buildMoveSteps, ixsRedeemMinUsd } = await import("../src/lib/execute.ts");
  const { getSignals } = await import("../src/lib/signals.ts");
  const s = await getSignals(agent);
  const min = await ixsRedeemMinUsd();
  console.log(`\nmoves (IXS redeem minimum $${min}, ETH $${s.rhEth.priceUsd})`);
  const moves = [
    { from: "base", to: "idle", usd: 20, bridge_required: false, why: "" },
    { from: "rh_eth", to: "idle", usd: 10, bridge_required: false, why: "" },
    { from: "ixs", to: "idle", usd: Math.max(50, min), bridge_required: false, why: "" },
  ] as never;
  const mSteps = await buildMoveSteps(moves, agent, s.rhEth.priceUsd!);
  for (const r of await simulate(mSteps, agent, undefined, { injectBalances: true })) console.log(`${r.ok ? "OK  " : "FAIL"} [${r.chain}] ${r.label}: ${r.detail}`);
}
