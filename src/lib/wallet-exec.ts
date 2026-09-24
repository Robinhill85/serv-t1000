"use client";
// Runs /api/wallet-steps transactions through the user's own wallet, one at a time, in order: switch to the step's
// chain (wagmi adds Robinhood Chain if the wallet doesn't know it), wait until any approval the step relies on is
// visible, re-check it on the server (fresh build + simulation from the wallet), send it for the user to confirm,
// then wait for the receipt. Stops at the first rejection, revert or failed re-check.
import { parseAbi, type Address } from "viem";
import type { Config } from "wagmi";
import { getAccount, readContract, switchChain, waitForTransactionReceipt } from "wagmi/actions";
import { CHAINS } from "./config";
import type { StepView } from "./use-t1000";
import type { WalletStep, WalletStepPrepare } from "@/app/api/wallet-steps/route";

const allowanceAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

async function waitForAllowance(config: Config, s: WalletStep, owner: Address, timeoutMs = 30_000) {
  if (!s.spends) return;
  const need = BigInt(s.spends.amount);
  const t0 = Date.now();
  for (;;) {
    const have = await readContract(config, {
      chainId: s.chainId, address: s.spends.token, abi: allowanceAbi, functionName: "allowance", args: [owner, s.spends.spender],
    }).catch(() => 0n);
    if (have >= need || Date.now() - t0 > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

function friendly(e: unknown): string {
  // Only errors from eth_sendTransaction are the wallet's; switching chain or reading an RPC can fail elsewhere.
  const fromWallet = (e as { walletError?: unknown })?.walletError;
  const err = (fromWallet ?? e) as { name?: string; shortMessage?: string; message?: string; details?: string; code?: number; cause?: { message?: string } };
  if (err?.name === "UserRejectedRequestError" || err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? "")) return "You declined this in your wallet. Nothing after it was sent.";
  const own = err?.details ?? err?.cause?.message ?? err?.message ?? String(e); // the source's own words
  const code = err?.code ? ` (code ${err.code})` : "";
  return (fromWallet ? `Your wallet refused this step${code}: ${own}` : `This step couldn't start${code}: ${own}`).slice(0, 280);
}

/**
 * The plainest request every EIP-1193 wallet accepts: from, to, data (+ a gas limit with headroom). The wallet sets fees.
 * (wagmi's sendTransaction first calls eth_estimateGas with extra fields some wallets reject: "Invalid parameters".)
 */
async function sendPlain(config: Config, owner: Address, s: WalletStep): Promise<`0x${string}`> {
  const provider = (await getAccount(config).connector?.getProvider()) as Eip1193 | undefined;
  if (!provider) throw new Error("Your wallet disconnected. Connect it again and retry.");
  const tx: Record<string, string> = { from: owner, to: s.to, data: s.data, value: "0x0" };
  if (s.gas) tx.gas = s.gas; // our pre-flight estimate + 30%: a bare estimate can run out (Morpho deposit, 24 Sep)
  return (await provider.request({ method: "eth_sendTransaction", params: [tx] })) as `0x${string}`;
}

/**
 * Receipt for a sent transaction: the public RPC first, then the user's own wallet provider (already on the right
 * chain). Null when neither can confirm it within the time limit.
 */
export async function confirm(config: Config, hash: `0x${string}`, chainId: number, limitMs = 120_000): Promise<{ status: "success" | "reverted" } | null> {
  // Both at once, first answer wins: the public RPC can refuse receipt lookups (Base publicnode: "Archive requests
  // require a personal token"), and the wallet's own RPC may lag. Null if neither confirms within the limit.
  let done = false;
  const viaPublic = waitForTransactionReceipt(config, { hash, chainId: chainId as never, timeout: limitMs })
    .then((r) => ({ status: r.status }))
    .catch((e) => { console.warn("T1000: public RPC could not confirm", e); return new Promise<never>(() => {}); });
  const viaWallet = (async () => {
    const provider = (await getAccount(config).connector?.getProvider()) as Eip1193 | undefined;
    const t0 = Date.now();
    while (provider && !done && Date.now() - t0 < limitMs) {
      const r = (await provider.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null)) as { status?: string } | null;
      if (r?.status) return { status: (r.status === "0x1" ? "success" : "reverted") as "success" | "reverted" };
      await new Promise((res) => setTimeout(res, 2000));
    }
    return new Promise<never>(() => {});
  })();
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), limitMs + 1000));
  const out = await Promise.race([viaPublic, viaWallet, timeout]);
  done = true;
  return out;
}

export type RunHooks = {
  /** Rebuilds and re-simulates a step on the server right before it is signed (fresh quote, last check). */
  prepare?: (key: string) => Promise<WalletStepPrepare>;
  /** A transaction was handed to the chain (kept so a retry can look it up instead of sending it again). */
  sent?: (s: WalletStep, hash: `0x${string}`) => void;
  /** A step is confirmed onchain (or an approval was already in place). */
  confirmed?: (key: string) => void;
};

/** Emits a full StepView per update: pending (awaiting signature / confirming), then confirmed or failed. */
export async function runWalletSteps(config: Config, steps: WalletStep[], owner: Address, onStep: (index: number, v: StepView) => void, hooks: RunHooks = {}): Promise<boolean> {
  for (const [i, planned] of steps.entries()) {
    let s = planned;
    let base: StepView = { key: s.key, venue: s.venue, chain: s.chain, label: s.label };
    try {
      if (getAccount(config).chainId !== s.chainId) {
        onStep(i, { ...base, detail: `Switch your wallet to ${CHAINS[s.chain].chain.name}…` });
        await switchChain(config, { chainId: s.chainId as never });
      }
      if (s.spends) {
        onStep(i, { ...base, detail: "Waiting for the approval to land…" });
        await waitForAllowance(config, s, owner);
      }
      // The first step was checked a moment ago with the whole run; later ones may be minutes later.
      if (i > 0 && hooks.prepare) {
        onStep(i, { ...base, detail: "Re-checking this step from your wallet…" });
        const r = await hooks.prepare(s.key).catch(() => ({ ok: false, error: "I couldn't re-check this step just now. Nothing was sent for it; try again." }) as WalletStepPrepare);
        if (r.skip) {
          onStep(i, { ...base, ok: true, detail: "Already in place, nothing to sign" });
          hooks.confirmed?.(s.key);
          continue;
        }
        if (!r.ok || !r.step) {
          onStep(i, { ...base, ok: false, detail: r.error ?? "This step didn't pass its last check. Nothing was sent for it." });
          return false;
        }
        s = r.step;
        base = { ...base, label: s.label };
      }
      onStep(i, { ...base, detail: `Confirm in your wallet. ${s.explain}` });
      let hash: `0x${string}`;
      try {
        hash = await sendPlain(config, owner, s);
      } catch (e) {
        throw Object.assign(new Error("wallet"), { walletError: e });
      }
      const explorer = `${CHAINS[s.chain].explorer}/tx/${hash}`;
      hooks.sent?.(s, hash);
      onStep(i, { ...base, detail: "Sent, confirming…", hash, explorer });
      const receipt = await confirm(config, hash, s.chainId);
      if (!receipt) {
        onStep(i, { ...base, ok: false, hash, explorer, detail: "Sent, but I couldn't confirm it yet. Check the tx link; nothing after it was sent. \"Finish the remaining steps\" checks it first, so it is never sent twice." });
        return false;
      }
      const ok = receipt.status === "success";
      if (ok) hooks.confirmed?.(s.key);
      onStep(i, { ...base, ok, hash, explorer, detail: ok ? "Confirmed" : "Reverted onchain. Nothing after it was sent." });
      if (!ok) return false;
    } catch (e) {
      console.error("T1000 wallet step failed", s.label, e);
      onStep(i, { ...base, ok: false, detail: friendly(e) });
      return false;
    }
  }
  return true;
}
