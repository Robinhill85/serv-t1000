// Live test of "My wallet" mode on Robinhood Chain, against the live site, with the agent wallet as the browser wallet.
// The agent key never enters the page: the page's wallet (EIP-1193, announced via EIP-6963) forwards every request to
// this Node process, which checks each transaction against a strict allowlist and a spend cap before signing it.
//
// Dry run (default): plans the run on the live site and clicks "Check it first" (simulated from the agent wallet).
// Nothing is signed.
//   npx tsx --env-file=.env.local scripts/live-rh-test.mts
// Live: deploys it through the site (the rulebook's $5 ETH minimum and 20% Base buffer make ~$8.50 the smallest run
// with an ETH leg), then undoes exactly what it added: sells the WETH it bought and redeems the Morpho shares it got.
// The agent's existing positions are untouched.
//   npx tsx --env-file=.env.local scripts/live-rh-test.mts --execute
// Options: --amount=8.5 (max 10) --headless --no-cleanup --site=https://serv-t1000.vercel.app
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { createWalletClient, decodeFunctionData, formatUnits, nonceManager, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, TOKENS, UNISWAP_RH, VENUES, type ChainKey } from "../src/lib/config.ts";
import { erc20Abi, publicClient, transport } from "../src/lib/clients.ts";

const arg = (name: string) => process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))?.split("=")[1] ?? (process.argv.includes(`--${name}`) ? "true" : undefined);
const EXECUTE = !!arg("execute");
const SITE = arg("site") ?? "https://serv-t1000.vercel.app";
const AMOUNT = Math.min(Number(arg("amount") ?? 8.5), 10);
const CAP = BigInt(Math.round(AMOUNT * 1e6)); // USDC / USDG base units the run may spend in total
const WALLET_NAME = "T1000 Test Wallet";

const pk = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
if (!pk) throw new Error("AGENT_PRIVATE_KEY is missing: run with --env-file=.env.local");
const account = privateKeyToAccount(pk, { nonceManager });
const agent = account.address;

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);

const BY_ID: Record<number, ChainKey> = { 8453: "base", 43114: "avalanche", 4663: "robinhood" };
const hex = (n: number) => `0x${n.toString(16)}`;
const MORPHO = VENUES.base.address!;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const depositAbi = parseAbi(["function deposit(uint256 assets, address receiver) returns (uint256 shares)"]);
const vaultAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
]);
const swapAbi = parseAbi(["function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)"]);
const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160, uint32, uint256)"]);

// ---------- the signer's own rules (independent of the site) ----------
let spent = 0n;
/** Null when the transaction is one this test may sign; otherwise why not. */
function vet(chainId: number, to: string, data: Hex): string | null {
  try {
    if (chainId === 8453 && same(to, TOKENS.base.USDC)) {
      const { args } = decodeFunctionData({ abi: approveAbi, data });
      return !same(args[0], MORPHO) ? "USDC approval for a spender other than the Morpho vault" : args[1] > CAP ? "USDC approval above the cap" : null;
    }
    if (chainId === 8453 && same(to, MORPHO)) {
      const { args } = decodeFunctionData({ abi: depositAbi, data });
      if (!same(args[1], agent)) return "deposit to a receiver other than this wallet";
      spent += args[0];
      return spent > CAP ? `spend above the $${AMOUNT} cap` : null;
    }
    if (chainId === 4663 && same(to, TOKENS.robinhood.USDG)) {
      const { args } = decodeFunctionData({ abi: approveAbi, data });
      return !same(args[0], UNISWAP_RH.swapRouter02) ? "USDG approval for a spender other than the Uniswap router" : args[1] > CAP ? "USDG approval above the cap" : null;
    }
    if (chainId === 4663 && same(to, UNISWAP_RH.swapRouter02)) {
      const { args } = decodeFunctionData({ abi: swapAbi, data });
      const p = args[0];
      if (!same(p.tokenIn, TOKENS.robinhood.USDG) || !same(p.tokenOut, TOKENS.robinhood.WETH)) return "a swap other than USDG -> WETH";
      if (!same(p.recipient, agent)) return "swap output to another address";
      if (p.amountOutMinimum === 0n) return "swap without a slippage floor";
      spent += p.amountIn;
      return spent > CAP ? `spend above the $${AMOUNT} cap` : null;
    }
  } catch {
    return "calldata that doesn't match the expected call";
  }
  return `${to} on chain ${chainId} is not on the allowlist`;
}

const wallets = new Map<ChainKey, ReturnType<typeof createWalletClient>>();
const walletFor = (key: ChainKey) => {
  if (!wallets.has(key)) wallets.set(key, createWalletClient({ account, chain: CHAINS[key].chain, transport: transport(key) }));
  return wallets.get(key)!;
};

// ---------- the page's wallet, answered here ----------
let chainId = 8453;
let authorized = false;
const known = new Set([8453, 43114]); // like a fresh MetaMask: Robinhood Chain gets added by the site
type RpcReply = { result?: unknown; error?: { code: number; message: string }; chainChanged?: string };
const fail = (code: number, message: string): RpcReply => ({ error: { code, message } });

async function rpc(method: string, params: unknown[]): Promise<RpcReply> {
  try {
    switch (method) {
      case "eth_requestAccounts": authorized = true; return { result: [agent] };
      case "eth_accounts": return { result: authorized ? [agent] : [] };
      case "eth_chainId": return { result: hex(chainId) };
      case "net_version": return { result: String(chainId) };
      case "wallet_requestPermissions": case "wallet_getPermissions": return { result: [{ parentCapability: "eth_accounts" }] };
      case "wallet_switchEthereumChain": {
        const id = parseInt((params[0] as { chainId: string }).chainId, 16);
        if (!known.has(id)) return fail(4902, "Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain first.");
        chainId = id;
        log(`wallet: switched to ${CHAINS[BY_ID[id]].chain.name}`);
        return { result: null, chainChanged: hex(id) };
      }
      case "wallet_addEthereumChain": {
        const p = params[0] as { chainId: string; chainName?: string; rpcUrls?: string[] };
        const id = parseInt(p.chainId, 16);
        if (!BY_ID[id]) return fail(4001, "This test wallet only knows Base, Avalanche and Robinhood Chain.");
        known.add(id);
        chainId = id;
        log(`wallet: site added ${p.chainName} (rpc ${p.rpcUrls?.[0]}) and switched to it`);
        return { result: null, chainChanged: hex(id) };
      }
      case "eth_sendTransaction": return await send(params[0] as { from: string; to: string; data: Hex; value?: string; gas?: Hex });
      case "personal_sign": case "eth_sign": case "eth_signTypedData_v4": return fail(4200, "This test wallet does not sign messages.");
      default: return { result: await publicClient(BY_ID[chainId]).request({ method, params } as never) };
    }
  } catch (e) {
    const err = e as { code?: number; shortMessage?: string; message?: string };
    return fail(err.code ?? -32603, String(err.shortMessage ?? err.message ?? e).slice(0, 300));
  }
}

async function send(tx: { from: string; to: string; data: Hex; value?: string; gas?: Hex }): Promise<RpcReply> {
  const key = BY_ID[chainId];
  if (!same(tx.from, agent)) return fail(4100, "from is not this wallet");
  if (tx.value && BigInt(tx.value) !== 0n) return fail(4001, "Test wallet refused: the transaction sends native value.");
  const why = vet(chainId, tx.to, tx.data);
  log(`wallet: asked to sign on ${CHAINS[key].chain.name} -> ${tx.to} ${tx.data.slice(0, 10)} gas limit ${tx.gas ? BigInt(tx.gas) : "wallet's own"}${why ? `  REFUSED: ${why}` : ""}`);
  if (why) return fail(4001, `Test wallet refused: ${why}`);
  if (!EXECUTE) return fail(4001, "Dry run: the test wallet declines every signature.");
  const hash = await walletFor(key).sendTransaction({ account, chain: CHAINS[key].chain, to: tx.to as Address, data: tx.data, value: 0n, gas: tx.gas ? BigInt(tx.gas) : undefined });
  log(`wallet: sent ${CHAINS[key].explorer}/tx/${hash}`);
  return { result: hash };
}

/** Runs in the page: an EIP-1193 wallet whose every request goes to rpc() above. */
function pageWallet({ name }: { name: string }) {
  const listeners: Record<string, ((v: unknown) => void)[]> = {};
  const emit = (ev: string, v: unknown) => (listeners[ev] ?? []).forEach((f) => { try { f(v); } catch { /* listener errors are the page's */ } });
  // Resolved per call: Playwright's exposed binding may attach after this script runs.
  const bridge = (m: string, p: unknown[]) => (window as unknown as { __t1000rpc: (m: string, p: unknown[]) => Promise<RpcReply> }).__t1000rpc(m, p);
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      const r = await bridge(method, params ?? []);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      if (r.chainChanged) emit("chainChanged", r.chainChanged);
      if (method === "eth_requestAccounts") emit("accountsChanged", r.result);
      return r.result;
    },
    on: (ev: string, f: (v: unknown) => void) => { (listeners[ev] ??= []).push(f); },
    removeListener: (ev: string, f: (v: unknown) => void) => { listeners[ev] = (listeners[ev] ?? []).filter((x) => x !== f); },
  };
  const icon = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'/>";
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "t1000-test-wallet", name, rdns: "local.t1000.testwallet", icon }, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}

// ---------- balances before / after ----------
async function snapshot() {
  const rh = publicClient("robinhood"), base = publicClient("base");
  const [weth, usdg, shares, usdc] = await Promise.all([
    rh.readContract({ address: TOKENS.robinhood.WETH, abi: erc20Abi, functionName: "balanceOf", args: [agent] }),
    rh.readContract({ address: TOKENS.robinhood.USDG, abi: erc20Abi, functionName: "balanceOf", args: [agent] }),
    base.readContract({ address: MORPHO, abi: vaultAbi, functionName: "balanceOf", args: [agent] }),
    base.readContract({ address: TOKENS.base.USDC, abi: erc20Abi, functionName: "balanceOf", args: [agent] }),
  ]);
  return { weth, usdg, shares, usdc };
}
const fmt = (s: Awaited<ReturnType<typeof snapshot>>) =>
  `WETH ${formatUnits(s.weth, 18)} · USDG ${formatUnits(s.usdg, 6)} (Robinhood) · Morpho shares ${formatUnits(s.shares, 18)} · USDC ${formatUnits(s.usdc, 6)} (Base)`;

/** Gas limit with headroom: Morpho's gas use varies, and viem's bare estimate left only 1.4% spare on 24 Sep. */
async function withHeadroom(key: ChainKey, req: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) {
  const est = await publicClient(key).estimateContractGas({ account, ...req } as never);
  return (est * 13n) / 10n + 20_000n;
}

/** Undoes what the run added, directly from this wallet (not through the site): exact deltas only. */
async function cleanup(before: Awaited<ReturnType<typeof snapshot>>) {
  const now = await snapshot();
  const wethIn = now.weth - before.weth;
  const shares = now.shares - before.shares;
  if (wethIn > 0n) {
    const rh = publicClient("robinhood");
    const { result } = await rh.simulateContract({
      address: UNISWAP_RH.quoterV2, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ tokenIn: TOKENS.robinhood.WETH, tokenOut: TOKENS.robinhood.USDG, amountIn: wethIn, fee: UNISWAP_RH.wethUsdgFee, sqrtPriceLimitX96: 0n }],
    });
    const minOut = (result[0] * 99n) / 100n;
    log(`cleanup: selling the ${formatUnits(wethIn, 18)} WETH this run bought (at least ${formatUnits(minOut, 6)} USDG)`);
    const w = walletFor("robinhood");
    const allowance = await rh.readContract({ address: TOKENS.robinhood.WETH, abi: erc20Abi, functionName: "allowance", args: [agent, UNISWAP_RH.swapRouter02] });
    if (allowance < wethIn) {
      const req = { address: TOKENS.robinhood.WETH, abi: approveAbi, functionName: "approve", args: [UNISWAP_RH.swapRouter02, wethIn] } as const;
      const h = await w.writeContract({ account, chain: CHAINS.robinhood.chain, ...req, gas: await withHeadroom("robinhood", req) });
      log(`cleanup: approve ${(await rh.waitForTransactionReceipt({ hash: h })).status} ${CHAINS.robinhood.explorer}/tx/${h}`);
    }
    const sell = {
      address: UNISWAP_RH.swapRouter02, abi: swapAbi, functionName: "exactInputSingle",
      args: [{ tokenIn: TOKENS.robinhood.WETH, tokenOut: TOKENS.robinhood.USDG, fee: UNISWAP_RH.wethUsdgFee, recipient: agent, amountIn: wethIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    } as const;
    const h = await w.writeContract({ account, chain: CHAINS.robinhood.chain, ...sell, gas: await withHeadroom("robinhood", sell) });
    log(`cleanup: sell ${(await rh.waitForTransactionReceipt({ hash: h })).status} ${CHAINS.robinhood.explorer}/tx/${h}`);
  }
  if (shares > 0n) {
    const base = publicClient("base");
    const assets = await base.readContract({ address: MORPHO, abi: vaultAbi, functionName: "convertToAssets", args: [shares] });
    log(`cleanup: redeeming the ${formatUnits(shares, 18)} Morpho shares this run added (~${formatUnits(assets, 6)} USDC)`);
    const req = { address: MORPHO, abi: vaultAbi, functionName: "redeem", args: [shares, agent, agent] } as const;
    const h = await walletFor("base").writeContract({ account, chain: CHAINS.base.chain, ...req, gas: await withHeadroom("base", req) });
    log(`cleanup: redeem ${(await base.waitForTransactionReceipt({ hash: h })).status} ${CHAINS.base.explorer}/tx/${h}`);
  }
  if (wethIn <= 0n && shares <= 0n) log("cleanup: nothing landed, nothing to undo");
}

// ---------- the run ----------
function chromePath(): string | undefined {
  if (process.env.CHROME) return process.env.CHROME;
  const root = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    const p = `${root}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT ?? "/Users/robin/Documents/Butler AI/node_modules/playwright") as typeof import("playwright");

log(`${EXECUTE ? "LIVE" : "DRY RUN"} · site ${SITE} · wallet ${agent} · cap $${AMOUNT}`);
const before = await snapshot();
log(`before: ${fmt(before)}`);

const browser = await chromium.launch({ headless: !!arg("headless"), executablePath: chromePath() });
let ok = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.exposeFunction("__t1000rpc", rpc);
  // tsx (esbuild keepNames) wraps named functions in __name(); the page needs a no-op for the serialized wallet code.
  await ctx.addInitScript({ content: "window.__name = window.__name || ((f) => f);" });
  await ctx.addInitScript(pageWallet, { name: WALLET_NAME });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") log(`page error: ${m.text().slice(0, 200)}`); });
  await page.goto(`${SITE}/?intro=0`, { waitUntil: "load" });

  await page.locator(".wallet-box .chips button", { hasText: WALLET_NAME }).click();
  await page.getByRole("button", { name: "Scan my wallet" }).click();
  await page.getByText("Your wallet holds").first().waitFor({ timeout: 90_000 });
  log("site:", (await page.getByText("Your wallet holds").first().innerText()).slice(0, 160));
  const chip = async (label: string | RegExp) => { await page.locator(".chips button", { hasText: label }).first().click(); await page.waitForTimeout(500); };
  await chip("UK");
  await page.getByLabel("Your answer").fill(String(AMOUNT));
  await page.getByLabel("Your answer").press("Enter");
  await page.getByText("How long can the money stay put?").last().waitFor({ timeout: 60_000 });
  for (const label of ["Over a year", "No, it can wait", "Volatile is fine", "High", "Skip"]) await chip(label);
  log("site: answers in (UK, $" + AMOUNT + ", over a year, can wait, volatile is fine, high). SERV is deciding…");

  await page.getByText(/Deploy from my wallet|can't fund|Not verified/).first().waitFor({ timeout: 240_000 });
  // The plan card only (the positions card above it has rows too).
  const planCard = page.locator(".msg-plan", { has: page.locator(".msg-kicker", { hasText: /^Plan ·/ }) });
  const rows = (await planCard.locator(".plan-leg .plan-row").allInnerTexts()).map((t) => t.replace(/\n/g, " "));
  log("plan:", rows.join(" | "));
  const ethRow = rows.find((r) => r.startsWith(VENUES.rh_eth.name));
  const total = rows.reduce((a, r) => a + Number(r.match(/\$([\d,.]+)\s*$/)?.[1]?.replace(/,/g, "") ?? 0), 0);
  if (!(await page.getByRole("button", { name: "Deploy from my wallet" }).count())) throw new Error("The site won't deploy this plan (see above).");
  if (!ethRow) throw new Error("SERV left ETH out of this plan (it decides the split within the rules). Run it again.");
  if (total > AMOUNT + 0.01) throw new Error(`Plan total $${total} is above the $${AMOUNT} cap.`);

  if (!EXECUTE) {
    await page.getByRole("button", { name: /Check it first/ }).click();
    await page.getByText(/every step passes|stopped/).first().waitFor({ timeout: 180_000 });
    for (const s of await page.$$eval(".exec-step", (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\n/g, " ")))) log("check:", s);
    ok = (await page.getByText(/every step passes/).count()) > 0;
    log(ok ? "DRY RUN passed: the live site pre-flights every step from the agent wallet. Nothing was signed. Add --execute to run it." : "DRY RUN: the pre-flight did not pass (see above).");
  } else {
    log(`LIVE in 5s: up to $${AMOUNT} from the agent wallet, then cleanup. Ctrl-C to abort.`);
    await page.waitForTimeout(5000);
    await page.locator(".risk input").check();
    await page.getByRole("button", { name: "Deploy from my wallet" }).click();
    await page.getByText(/Deploy · your wallet · live · (all confirmed|stopped)/).first().waitFor({ timeout: 480_000 });
    for (const s of await page.$$eval(".exec-step", (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\n/g, " ")))) log("site:", s);
    ok = (await page.getByText(/Deploy · your wallet · live · all confirmed/).count()) > 0;
    log(ok ? "site: every step confirmed through the live site" : "site: the run stopped (see above)");
    await page.screenshot({ path: "assets/takes/live/live-rh-test.png" });
  }
} catch (e) {
  log("FAILED:", e instanceof Error ? e.message.split("\n")[0] : e);
} finally {
  await browser.close();
}

if (EXECUTE && !arg("no-cleanup")) await cleanup(before).catch((e) => log("cleanup FAILED:", e instanceof Error ? e.message.split("\n")[0] : e));
if (EXECUTE) { await new Promise((r) => setTimeout(r, 4000)); log(`after:  ${fmt(await snapshot())} (read 4s after cleanup; RPC nodes can lag a block)`); }
process.exit(ok ? 0 : 1);
