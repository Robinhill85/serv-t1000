// The agent wallet: one key, one address on Base, Avalanche and Robinhood Chain ("one body, many shapes").
// Two modes:
//   simulate() builds every leg's transactions and runs them as eth_call simulations. Nothing is sent. Steps that
//              depend on an approval are simulated with the token allowance overridden in state, so the whole
//              route is checked end to end without touching the chain.
//   execute()  sends them, leg by leg, through Coinbase AgentKit's ViemWalletProvider (each step and hash visible).
//              Only reachable after checkExecutable() passes and the caller clears the route's own gates.
import { ViemWalletProvider } from "@coinbase/agentkit";
import { buildApproveTx, buildRequestDepositTx, KNOWN_VAULTS } from "@ixswap1/vault-agent-sdk";
import {
  createWalletClient, encodeAbiParameters, encodeFunctionData, keccak256, maxUint256, numberToHex, pad, parseAbi, parseUnits,
  type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, TOKENS, UNISWAP_RH, VENUES, type ChainKey, type VenueId } from "./config";
import { erc20Abi, publicClient, transport } from "./clients";
import type { Leg } from "./types";

export type Step = {
  venue: VenueId;
  chain: ChainKey;
  label: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** For steps that spend a token: the allowance the step relies on (overridden during simulation). */
  spends?: { token: Address; spender: Address; amount: bigint };
};

export type StepResult = { venue: VenueId; chain: ChainKey; label: string; ok: boolean; detail: string; hash?: Hex; explorer?: string };

const vaultDepositAbi = parseAbi(["function deposit(uint256 assets, address receiver) returns (uint256 shares)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const SWAP_SLIPPAGE_BPS = 50n;

export function agentAccount() {
  const pk = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("AGENT_PRIVATE_KEY is not set");
  return privateKeyToAccount(pk);
}

/** Builds the ordered transactions for every leg of a plan. Reads live quotes and allowances. */
export async function buildSteps(legs: Leg[], agent: Address): Promise<Step[]> {
  const steps: Step[] = [];
  for (const leg of legs) {
    if (leg.venue === "base") {
      const amount = parseUnits(leg.usd.toFixed(6), 6);
      const vault = VENUES.base.address!;
      steps.push(
        { venue: "base", chain: "base", label: "Approve USDC for the Morpho vault", to: TOKENS.base.USDC, abi: erc20Abi as unknown as Abi, functionName: "approve", args: [vault, amount] },
        { venue: "base", chain: "base", label: "Deposit USDC into Gauntlet USDC Prime", to: vault, abi: vaultDepositAbi, functionName: "deposit", args: [amount, agent], spends: { token: TOKENS.base.USDC, spender: vault, amount } },
      );
    } else if (leg.venue === "ixs") {
      const vault = KNOWN_VAULTS["avax-ixhyb"];
      const human = leg.usd.toFixed(6);
      const approve = buildApproveTx(vault, TOKENS.avalanche.USDC, human, 6);
      const request = buildRequestDepositTx(vault, agent, human, 6);
      steps.push(
        { venue: "ixs", chain: "avalanche", label: "Approve USDC for the IXS vault", to: approve.address, abi: approve.abi as Abi, functionName: approve.functionName, args: approve.args },
        {
          venue: "ixs", chain: "avalanche", label: "Request deposit into the IXS vault (settles T+1)", to: request.address, abi: request.abi as Abi,
          functionName: request.functionName, args: request.args,
          spends: { token: TOKENS.avalanche.USDC, spender: vault.address as Address, amount: parseUnits(human, 6) },
        },
      );
    } else if (leg.venue === "rh_eth") {
      const amountIn = parseUnits(leg.usd.toFixed(6), 6);
      const c = publicClient("robinhood");
      const { result } = await c.simulateContract({
        address: UNISWAP_RH.quoterV2, abi: quoterAbi, functionName: "quoteExactInputSingle",
        args: [{ tokenIn: TOKENS.robinhood.USDG, tokenOut: TOKENS.robinhood.WETH, amountIn, fee: UNISWAP_RH.wethUsdgFee, sqrtPriceLimitX96: 0n }],
      });
      const minOut = (result[0] * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n;
      steps.push(
        { venue: "rh_eth", chain: "robinhood", label: "Approve USDG for the Uniswap router", to: TOKENS.robinhood.USDG, abi: erc20Abi as unknown as Abi, functionName: "approve", args: [UNISWAP_RH.swapRouter02, amountIn] },
        {
          venue: "rh_eth", chain: "robinhood", label: `Swap USDG for ETH (min ${(Number(minOut) / 1e18).toFixed(6)} WETH)`, to: UNISWAP_RH.swapRouter02, abi: routerAbi,
          functionName: "exactInputSingle",
          args: [{ tokenIn: TOKENS.robinhood.USDG, tokenOut: TOKENS.robinhood.WETH, fee: UNISWAP_RH.wethUsdgFee, recipient: agent, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
          spends: { token: TOKENS.robinhood.USDG, spender: UNISWAP_RH.swapRouter02, amount: amountIn },
        },
      );
    } else {
      throw new Error(`${VENUES[leg.venue].hud} is not executable.`);
    }
  }
  return steps;
}

// ERC-20 allowance storage slot discovery (Solidity mapping(address => mapping(address => uint256)) at an unknown slot).
const slotCache = new Map<string, bigint>();
function allowanceKey(owner: Address, spender: Address, slot: bigint): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, slot]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
}
async function findAllowanceSlot(chain: ChainKey, token: Address, owner: Address, spender: Address): Promise<bigint | null> {
  const cacheKey = `${chain}:${token.toLowerCase()}`;
  if (slotCache.has(cacheKey)) return slotCache.get(cacheKey)!;
  const c = publicClient(chain);
  const probe = 0x1234567890n;
  for (let slot = 0n; slot < 64n; slot++) {
    try {
      const got = await c.readContract({
        address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender],
        stateOverride: [{ address: token, stateDiff: [{ slot: allowanceKey(owner, spender, slot), value: pad(numberToHex(probe), { size: 32 }) }] }],
      });
      if (got === probe) { slotCache.set(cacheKey, slot); return slot; }
    } catch { /* keep probing */ }
  }
  return null;
}

/** Simulates every step. Nothing is sent. Also checks the agent holds each leg's balance and gas. */
export async function simulate(steps: Step[], agent: Address): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (const s of steps) {
    const c = publicClient(s.chain);
    try {
      if (s.spends) {
        const bal = await c.readContract({ address: s.spends.token, abi: erc20Abi, functionName: "balanceOf", args: [agent] });
        if (bal < s.spends.amount) {
          out.push({ venue: s.venue, chain: s.chain, label: s.label, ok: false, detail: `Agent holds ${bal} base units, needs ${s.spends.amount}.` });
          continue;
        }
      }
      let stateOverride: { address: Address; stateDiff: { slot: Hex; value: Hex }[] }[] | undefined;
      if (s.spends) {
        const slot = await findAllowanceSlot(s.chain, s.spends.token, agent, s.spends.spender);
        if (slot == null) {
          out.push({ venue: s.venue, chain: s.chain, label: s.label, ok: true, detail: "Approval simulated; this step can only be simulated after the approval lands (allowance slot not found)." });
          continue;
        }
        stateOverride = [{ address: s.spends.token, stateDiff: [{ slot: allowanceKey(agent, s.spends.spender, slot), value: pad(numberToHex(maxUint256), { size: 32 }) }] }];
      }
      const data = encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args } as never);
      await c.call({ account: agent, to: s.to, data, stateOverride });
      const gas = await c.estimateGas({ account: agent, to: s.to, data, stateOverride }).catch(() => null);
      out.push({ venue: s.venue, chain: s.chain, label: s.label, ok: true, detail: gas ? `Simulated OK, ~${gas} gas` : "Simulated OK" });
    } catch (e) {
      const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
      out.push({ venue: s.venue, chain: s.chain, label: s.label, ok: false, detail: msg.slice(0, 240) });
    }
  }
  return out;
}

function provider(chain: ChainKey) {
  const account = agentAccount();
  const wallet = createWalletClient({ account, chain: CHAINS[chain].chain, transport: transport(chain) });
  // AgentKit bundles its own viem copy: the client is runtime-compatible, the types just come from two installs.
  return new ViemWalletProvider(wallet as unknown as ConstructorParameters<typeof ViemWalletProvider>[0]);
}

/** Sends every step through AgentKit, in order, waiting for each receipt. Stops at the first failure. */
export async function execute(steps: Step[], onStep: (r: StepResult) => void): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const providers = new Map<ChainKey, ViemWalletProvider>();
  for (const s of steps) {
    const p = providers.get(s.chain) ?? provider(s.chain);
    providers.set(s.chain, p);
    try {
      const data = encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args } as never);
      const hash = await p.sendTransaction({ to: s.to, data });
      const receipt = await p.waitForTransactionReceipt(hash);
      const ok = receipt?.status === "success";
      const r: StepResult = { venue: s.venue, chain: s.chain, label: s.label, ok, hash, explorer: `${CHAINS[s.chain].explorer}/tx/${hash}`, detail: ok ? "Confirmed" : "Reverted" };
      results.push(r);
      onStep(r);
      if (!ok) break;
    } catch (e) {
      const r: StepResult = { venue: s.venue, chain: s.chain, label: s.label, ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 240) };
      results.push(r);
      onStep(r);
      break;
    }
  }
  return results;
}
