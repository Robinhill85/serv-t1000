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
for (const r of await simulate(steps, agent)) console.log(`${r.ok ? "OK  " : "FAIL"} [${r.chain}] ${r.label}: ${r.detail}`);
