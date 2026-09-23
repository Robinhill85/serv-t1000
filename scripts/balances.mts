// Agent wallet balances + gas headroom. `npx tsx --env-file=.env.local scripts/balances.mts [address]`
import { formatEther, formatGwei, type Address } from "viem";
import { scanWallet } from "../src/lib/scan.ts";
import { publicClient } from "../src/lib/clients.ts";

const addr = (process.argv[2] ?? "0x2C12CF9dcb6C4958216e7eCe4c71a2Ebc3db358a") as Address;
const { holdings, errors } = await scanWallet(addr);
for (const h of holdings) console.log(`${h.chain.padEnd(10)} ${h.symbol.padEnd(5)} ${h.amount}`);
if (errors.length) console.log("ERRORS", errors);
for (const chain of ["base", "avalanche", "robinhood"] as const) {
  const gp = await publicClient(chain).getGasPrice();
  const perTx = 200_000n * gp; // generous per-tx budget (approve ~50k, deposit/swap ~150-200k)
  console.log(`gas ${chain.padEnd(10)} price ${formatGwei(gp)} gwei, ~${formatEther(perTx)} native per 200k-gas tx`);
}
