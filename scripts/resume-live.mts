// Finishes the legs of a live run that stopped partway (first live run, 24 Sep: IXS $105 went through, the Base
// deposit hit a lagging RPC node, the Robinhood swap never started). Same builders, pre-flight and executor as the app.
// Dry run by default: every step is eth_call-simulated, nothing is sent.
//   dry run:  npx tsx --env-file=.env.local scripts/resume-live.mts
//   execute:  npx tsx --env-file=.env.local scripts/resume-live.mts --execute      (needs EXECUTION_ENABLED=true)
//   custom:   ... scripts/resume-live.mts base=30 rh_eth=15 [--execute]
import { executionLimits } from "../src/lib/config.ts";
import { agentAddress, buildSteps, execute, simulate } from "../src/lib/execute.ts";
import type { Leg } from "../src/lib/types.ts";

const args = process.argv.slice(2);
const send = args.includes("--execute");
const custom = args.filter((a) => a.includes("=")).map((a) => a.split("=")) as [Leg["venue"], string][];
const legs: Leg[] = (custom.length ? custom : ([["base", "30"], ["rh_eth", "15"]] as [Leg["venue"], string][]))
  .map(([venue, usd]) => ({ venue, pct: 0, usd: Number(usd) }));
if (legs.some((l) => l.venue === "ixs")) throw new Error("This script does not deposit into IXS (the IXS leg already went through).");

const total = legs.reduce((a, l) => a + l.usd, 0);
const limits = executionLimits();
if (total > limits.maxRunUsd) throw new Error(`Legs total $${total}, over the MAX_RUN_USD cap of $${limits.maxRunUsd}.`);

const agent = agentAddress();
console.log(`Agent ${agent}\nLegs: ${legs.map((l) => `${l.venue} $${l.usd}`).join(", ")} (total $${total})\n`);
const steps = await buildSteps(legs, agent);

console.log("Pre-flight simulation (nothing is sent):");
const dry = await simulate(steps, agent, (r) => console.log(`  ${r.ok ? "OK  " : "FAIL"} ${r.chain.padEnd(9)} ${r.label} :: ${r.detail}`));
if (dry.some((r) => !r.ok)) { console.log("\nA step fails in simulation: nothing will be sent. Fix that first."); process.exit(1); }

if (!send) { console.log("\nAll steps pass. Re-run with --execute (and EXECUTION_ENABLED=true) to send them."); process.exit(0); }
if (!limits.enabled) { console.log("\nEXECUTION_ENABLED is not true in .env.local: refusing to send."); process.exit(1); }

console.log("\nSending:");
const results = await execute(steps, (r) => console.log(`  ${r.ok ? "OK  " : "FAIL"} ${r.chain.padEnd(9)} ${r.label} :: ${r.detail}${r.explorer ? `  ${r.explorer}` : ""}`));
const ok = results.length === steps.length && results.every((r) => r.ok);
console.log(ok ? "\nDone: every step confirmed." : "\nStopped: see the failing step above. Nothing after it was sent.");
process.exit(ok ? 0 : 1);
