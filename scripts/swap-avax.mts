// One-off funding helper: swap the agent wallet's surplus AVAX to native USDC on Avalanche (Uniswap v3),
// keeping a gas reserve. Dry run by default (quote + eth_call simulation, nothing is sent).
//   dry run:  npx tsx --env-file=.env.local scripts/swap-avax.mts
//   execute:  npx tsx --env-file=.env.local scripts/swap-avax.mts --execute
import { createWalletClient, formatEther, formatUnits, parseAbi, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche } from "viem/chains";
import { publicClient, transport } from "../src/lib/clients.ts";
import { TOKENS } from "../src/lib/config.ts";

const KEEP_AVAX = parseEther(process.env.KEEP_AVAX ?? "0.5");
const SLIPPAGE_BPS = 100n; // 1%
const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7" as Address;
const USDC = TOKENS.avalanche.USDC;
// developers.uniswap.org/docs/protocols/v3/deployments/v3-avalanche-deployments
const FACTORY = "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD" as Address;
const QUOTER_V2 = "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F" as Address;
const ROUTER = "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE" as Address;

const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]);
const routerAbi = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
const erc = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const pk = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!pk) throw new Error("AGENT_PRIVATE_KEY missing");
const account = privateKeyToAccount(pk);
const c = publicClient("avalanche");
const execute = process.argv.includes("--execute");

const balance = await c.getBalance({ address: account.address });
const amountIn = balance - KEEP_AVAX;
console.log(`agent ${account.address}\nAVAX balance ${formatEther(balance)}, keeping ${formatEther(KEEP_AVAX)}, swapping ${formatEther(amountIn > 0n ? amountIn : 0n)}`);
if (amountIn <= 0n) throw new Error("Nothing to swap above the gas reserve.");

// Pick the fee tier with the best quote among pools that exist.
let best: { fee: number; out: bigint } | null = null;
for (const fee of [500, 3000, 100, 10000]) {
  const pool = await c.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getPool", args: [WAVAX, USDC, fee] });
  if (/^0x0+$/.test(pool)) continue;
  const usdcInPool = await c.readContract({ address: USDC, abi: erc, functionName: "balanceOf", args: [pool] });
  try {
    const { result } = await c.simulateContract({ address: QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: WAVAX, tokenOut: USDC, amountIn, fee, sqrtPriceLimitX96: 0n }] });
    console.log(`  pool fee ${fee}: ${pool}, USDC depth ${formatUnits(usdcInPool, 6)}, quote ${formatUnits(result[0], 6)} USDC`);
    if (!best || result[0] > best.out) best = { fee, out: result[0] };
  } catch {
    console.log(`  pool fee ${fee}: quote failed`);
  }
}
if (!best) throw new Error("No WAVAX/USDC pool quoted.");
const minOut = (best.out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
const params = { tokenIn: WAVAX, tokenOut: USDC, fee: best.fee, recipient: account.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n } as const;
console.log(`best: fee ${best.fee}, expect ${formatUnits(best.out, 6)} USDC, minimum ${formatUnits(minOut, 6)} (1% slippage)`);

// Simulation: the exact transaction, as an eth_call from the agent address. Moves nothing.
const sim = await c.simulateContract({ account, address: ROUTER, abi: routerAbi, functionName: "exactInputSingle", args: [params], value: amountIn });
console.log(`simulation OK: router would return ${formatUnits(sim.result, 6)} USDC`);

if (!execute) {
  console.log("\nDRY RUN: nothing sent. Re-run with --execute to send the swap.");
  process.exit(0);
}
const wallet = createWalletClient({ account, chain: avalanche, transport: transport("avalanche") });
const hash = await wallet.writeContract(sim.request);
console.log(`sent ${hash}\nwaiting for receipt...`);
const receipt = await c.waitForTransactionReceipt({ hash });
const usdc = await c.readContract({ address: USDC, abi: erc, functionName: "balanceOf", args: [account.address] });
console.log(`${receipt.status} in block ${receipt.blockNumber}: https://snowtrace.io/tx/${hash}\nUSDC balance now ${formatUnits(usdc, 6)}, AVAX ${formatEther(await c.getBalance({ address: account.address }))}`);
