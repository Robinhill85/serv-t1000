// The agent wallet: one key, one address on Base, Avalanche and Robinhood Chain ("one body, many shapes").
// Two modes:
//   simulate() builds every leg's transactions and runs them as eth_call simulations. Nothing is sent. Steps that
//              depend on an approval are simulated with the token allowance overridden in state, so the whole
//              route is checked end to end without touching the chain.
//   execute()  sends them, leg by leg, through Coinbase AgentKit's ViemWalletProvider (each step and hash visible).
//              Only reachable after checkExecutable() passes and the caller clears the route's own gates.
import type { ViemWalletProvider } from "@coinbase/agentkit";
import { buildApproveTx, buildRequestDepositTx, buildRequestRedeemTx, KNOWN_VAULTS } from "@ixswap1/vault-agent-sdk";
import {
  createWalletClient, encodeAbiParameters, encodeFunctionData, formatUnits, keccak256, maxUint256, numberToHex, pad, parseAbi, parseUnits,
  type Abi, type Address, type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { CHAINS, TOKENS, UNISWAP_RH, VENUES, type ChainKey, type VenueId } from "./config";
import { erc20Abi, publicClient, transport } from "./clients";
import type { Move } from "./rebalance";
import { isRetryableEstimateError, RETRY_DELAY_MS, SEND_ATTEMPTS } from "./exec-retry";
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
  /** For steps that need the agent to hold a token (vault shares, WETH): injected in simulation if not yet held. */
  holds?: { token: Address; amount: bigint };
};

export type StepResult = { venue: VenueId; chain: ChainKey; label: string; ok: boolean; detail: string; hash?: Hex; explorer?: string };

const vaultDepositAbi = parseAbi(["function deposit(uint256 assets, address receiver) returns (uint256 shares)"]);
const vaultWithdrawAbi = parseAbi(["function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)"]);
const vaultReadAbi = parseAbi(["function convertToShares(uint256) view returns (uint256)", "function decimals() view returns (uint8)", "function minRedeemAssets() view returns (uint256)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const SWAP_SLIPPAGE_BPS = 50n;

/** Signing account: only exists where live runs are allowed (Robin's machine). Never configured on Vercel. */
export function agentAccount() {
  const pk = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("Live runs are not available on this deployment.");
  // The nonce manager remembers the last nonce it used, so a lagging RPC node cannot hand out a stale one.
  return privateKeyToAccount(pk, { nonceManager });
}

/** The agent's public address: enough to read positions and simulate. Prefers AGENT_ADDRESS (no key needed). */
export function agentAddress(): Address {
  const a = process.env.AGENT_ADDRESS as Address | undefined;
  if (a && /^0x[0-9a-fA-F]{40}$/.test(a)) return a;
  return agentAccount().address;
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

/**
 * Transactions for Guard-mode moves. Money going into a venue reuses the plan builders; money coming out uses
 * Morpho withdraw, a WETH->USDG swap, or an IXS redeem request (settles T+1). Only same-chain moves reach here.
 */
export async function buildMoveSteps(moves: Move[], agent: Address, ethPriceUsd: number): Promise<Step[]> {
  const steps: Step[] = [];
  for (const m of moves) {
    if (m.from === "idle" && m.to !== "idle") {
      steps.push(...(await buildSteps([{ venue: m.to, pct: 0, usd: m.usd }], agent)));
      continue;
    }
    if (m.from === "base") {
      const amount = parseUnits(m.usd.toFixed(6), 6);
      const shares = await publicClient("base").readContract({ address: VENUES.base.address!, abi: vaultReadAbi, functionName: "convertToShares", args: [amount] });
      steps.push({
        venue: "base", chain: "base", label: `Withdraw $${m.usd.toFixed(2)} from Gauntlet USDC Prime`, to: VENUES.base.address!, abi: vaultWithdrawAbi,
        functionName: "withdraw", args: [amount, agent, agent], holds: { token: VENUES.base.address!, amount: (shares * 101n) / 100n },
      });
    } else if (m.from === "rh_eth") {
      const wethIn = parseUnits((m.usd / ethPriceUsd).toFixed(18), 18);
      const c = publicClient("robinhood");
      const { result } = await c.simulateContract({
        address: UNISWAP_RH.quoterV2, abi: quoterAbi, functionName: "quoteExactInputSingle",
        args: [{ tokenIn: TOKENS.robinhood.WETH, tokenOut: TOKENS.robinhood.USDG, amountIn: wethIn, fee: UNISWAP_RH.wethUsdgFee, sqrtPriceLimitX96: 0n }],
      });
      const minOut = (result[0] * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n;
      steps.push(
        { venue: "rh_eth", chain: "robinhood", label: "Approve WETH for the Uniswap router", to: TOKENS.robinhood.WETH, abi: erc20Abi as unknown as Abi, functionName: "approve", args: [UNISWAP_RH.swapRouter02, wethIn], holds: { token: TOKENS.robinhood.WETH, amount: wethIn } },
        {
          venue: "rh_eth", chain: "robinhood", label: `Trim ETH: swap ${(Number(wethIn) / 1e18).toFixed(6)} WETH for at least $${(Number(minOut) / 1e6).toFixed(2)} USDG`,
          to: UNISWAP_RH.swapRouter02, abi: routerAbi, functionName: "exactInputSingle",
          args: [{ tokenIn: TOKENS.robinhood.WETH, tokenOut: TOKENS.robinhood.USDG, fee: UNISWAP_RH.wethUsdgFee, recipient: agent, amountIn: wethIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
          spends: { token: TOKENS.robinhood.WETH, spender: UNISWAP_RH.swapRouter02, amount: wethIn },
          holds: { token: TOKENS.robinhood.WETH, amount: wethIn },
        },
      );
    } else if (m.from === "ixs") {
      const vault = KNOWN_VAULTS["avax-ixhyb"];
      const c = publicClient("avalanche");
      const [shares, decimals] = await Promise.all([
        c.readContract({ address: vault.address, abi: vaultReadAbi, functionName: "convertToShares", args: [parseUnits(m.usd.toFixed(6), 6)] }),
        c.readContract({ address: vault.address, abi: vaultReadAbi, functionName: "decimals" }),
      ]);
      const tx = buildRequestRedeemTx(vault, agent, formatUnits(shares, decimals), decimals);
      steps.push({
        venue: "ixs", chain: "avalanche", label: `Request IXS exit of ~$${m.usd.toFixed(2)} (settles T+1, 0.5% fee)`, to: tx.address, abi: tx.abi as Abi,
        functionName: tx.functionName, args: tx.args, holds: { token: vault.address as Address, amount: shares },
      });
    } else {
      throw new Error(`Move ${m.from} -> ${m.to} is not executable.`);
    }
  }
  return steps;
}

/** The IXS vault's live minimum exit, in USD. */
export async function ixsRedeemMinUsd(): Promise<number> {
  const c = publicClient("avalanche");
  const min = await c.readContract({ address: KNOWN_VAULTS["avax-ixhyb"].address, abi: vaultReadAbi, functionName: "minRedeemAssets" }).catch(() => 0n);
  return Number(formatUnits(min, 6));
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

// ERC-20 balance storage slot discovery: mapping(address => uint256) at a plain slot, or OpenZeppelin v5's
// ERC-7201 namespaced ERC20 storage (upgradeable vaults such as IXS).
const OZ_ERC20_NAMESPACE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
const balanceSlotCache = new Map<string, bigint>();
function balanceKey(owner: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, slot]));
}
async function findBalanceSlot(chain: ChainKey, token: Address, owner: Address): Promise<bigint | null> {
  const cacheKey = `${chain}:${token.toLowerCase()}`;
  if (balanceSlotCache.has(cacheKey)) return balanceSlotCache.get(cacheKey)!;
  const c = publicClient(chain);
  const probe = 0x9876543210n;
  const candidates = [OZ_ERC20_NAMESPACE, ...Array.from({ length: 64 }, (_, i) => BigInt(i))];
  for (const slot of candidates) {
    try {
      const got = await c.readContract({
        address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner],
        stateOverride: [{ address: token, stateDiff: [{ slot: balanceKey(owner, slot), value: pad(numberToHex(probe), { size: 32 }) }] }],
      });
      if (got === probe) { balanceSlotCache.set(cacheKey, slot); return slot; }
    } catch { /* keep probing */ }
  }
  return null;
}

/** Simulates every step. Nothing is sent. Also checks the agent holds each leg's balance and gas. */
export async function simulate(steps: Step[], agent: Address, onStep?: (r: StepResult) => void): Promise<StepResult[]> {
  const out: StepResult[] = [];
  const push = (r: StepResult) => { out.push(r); onStep?.(r); };
  for (const s of steps) {
    const c = publicClient(s.chain);
    try {
      // Spending a token the step also "holds" is covered by injection below; otherwise the agent must hold it.
      if (s.spends && s.spends.token.toLowerCase() !== s.holds?.token.toLowerCase()) {
        const bal = await c.readContract({ address: s.spends.token, abi: erc20Abi, functionName: "balanceOf", args: [agent] });
        if (bal < s.spends.amount) {
          push({ venue: s.venue, chain: s.chain, label: s.label, ok: false, detail: `Agent holds ${bal} base units, needs ${s.spends.amount}.` });
          continue;
        }
      }
      let stateOverride: { address: Address; stateDiff: { slot: Hex; value: Hex }[] }[] | undefined;
      let injected = false;
      if (s.holds) {
        const bal = await c.readContract({ address: s.holds.token, abi: erc20Abi, functionName: "balanceOf", args: [agent] });
        if (bal < s.holds.amount) {
          const slot = await findBalanceSlot(s.chain, s.holds.token, agent);
          if (slot == null) {
            push({ venue: s.venue, chain: s.chain, label: s.label, ok: false, detail: "Agent holds no position here and it could not be injected for simulation." });
            continue;
          }
          stateOverride = [{ address: s.holds.token, stateDiff: [{ slot: balanceKey(agent, slot), value: pad(numberToHex(s.holds.amount), { size: 32 }) }] }];
          injected = true;
        }
      }
      if (s.spends) {
        const slot = await findAllowanceSlot(s.chain, s.spends.token, agent, s.spends.spender);
        if (slot == null) {
          push({ venue: s.venue, chain: s.chain, label: s.label, ok: true, detail: "Approval simulated; this step can only be simulated after the approval lands (allowance slot not found)." });
          continue;
        }
        const allowanceDiff = { slot: allowanceKey(agent, s.spends.spender, slot), value: pad(numberToHex(maxUint256), { size: 32 }) };
        const same = stateOverride?.find((o) => o.address.toLowerCase() === s.spends!.token.toLowerCase());
        if (same) same.stateDiff.push(allowanceDiff);
        else stateOverride = [...(stateOverride ?? []), { address: s.spends.token, stateDiff: [allowanceDiff] }];
      }
      const data = encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args } as never);
      await c.call({ account: agent, to: s.to, data, stateOverride });
      const gas = await c.estimateGas({ account: agent, to: s.to, data, stateOverride }).catch(() => null);
      const note = injected ? " (position injected for simulation)" : "";
      push({ venue: s.venue, chain: s.chain, label: s.label, ok: true, detail: (gas ? `Simulated OK, ~${gas} gas` : "Simulated OK") + note });
    } catch (e) {
      const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
      push({ venue: s.venue, chain: s.chain, label: s.label, ok: false, detail: msg.slice(0, 240) });
    }
  }
  return out;
}

// AgentKit is loaded only when a live run sends transactions: its dependency tree (Solana, native bigint bindings)
// breaks Next's build-time route analysis if imported at module scope.
async function provider(chain: ChainKey) {
  const { ViemWalletProvider } = await import("@coinbase/agentkit");
  // AgentKit fires an un-awaited analytics call (wallet address included) from the provider constructor; when that
  // request fails it becomes an unhandled rejection that can kill the process mid-run. Skip it.
  // (trackInitialization is private in AgentKit's types, so the override goes through a cast.)
  const Provider = class extends (ViemWalletProvider as unknown as new (w: unknown) => object) {
    trackInitialization() {}
  } as unknown as typeof ViemWalletProvider;
  const account = agentAccount();
  const wallet = createWalletClient({ account, chain: CHAINS[chain].chain, transport: transport(chain) });
  // AgentKit bundles its own viem copy: the client is runtime-compatible, the types just come from two installs.
  return new Provider(wallet as unknown as ConstructorParameters<typeof ViemWalletProvider>[0]);
}

/** Sends every step through AgentKit, in order, waiting for each receipt. Stops at the first failure. */
/** Waits (up to 20s) until the chain shows the allowance a step spends; the approve may be on a node ahead of this one. */
async function waitForAllowance(s: Step, owner: Address, timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const a = await publicClient(s.chain)
      .readContract({ address: s.spends!.token, abi: erc20Abi, functionName: "allowance", args: [owner, s.spends!.spender] })
      .catch(() => 0n);
    if (a >= s.spends!.amount || Date.now() - t0 > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export async function execute(steps: Step[], onStep: (r: StepResult) => void): Promise<StepResult[]> {
  const account = agentAccount().address;
  const results: StepResult[] = [];
  const providers = new Map<ChainKey, ViemWalletProvider>();
  for (const s of steps) {
    const p = providers.get(s.chain) ?? (await provider(s.chain));
    providers.set(s.chain, p);
    try {
      const data = encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args } as never);
      if (s.spends) await waitForAllowance(s, account);
      let hash: Hex | undefined;
      for (let attempt = 1; !hash; attempt++) {
        try {
          hash = await p.sendTransaction({ to: s.to, data });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt >= SEND_ATTEMPTS || !isRetryableEstimateError(msg)) throw e;
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
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
