"use client";
// Runs /api/wallet-steps transactions through the user's own wallet, one at a time, in order: switch to the step's
// chain (wagmi adds Robinhood Chain if the wallet doesn't know it), wait until any approval the step relies on is
// visible, send it for the user to confirm, then wait for the receipt. Stops at the first rejection or revert.
import { parseAbi, type Address } from "viem";
import type { Config } from "wagmi";
import { getAccount, readContract, sendTransaction, switchChain, waitForTransactionReceipt } from "wagmi/actions";
import { CHAINS } from "./config";
import type { StepView } from "./use-t1000";
import type { WalletStep } from "@/app/api/wallet-steps/route";

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

function friendly(e: unknown): string {
  const err = e as { name?: string; shortMessage?: string; message?: string; code?: number };
  if (err?.name === "UserRejectedRequestError" || err?.code === 4001 || /reject|denied/i.test(err?.message ?? "")) return "You declined this in your wallet. Nothing after it was sent.";
  return (err?.shortMessage ?? err?.message ?? String(e)).slice(0, 240);
}

/** Emits a full StepView per update: pending (awaiting signature / confirming), then confirmed or failed. */
export async function runWalletSteps(config: Config, steps: WalletStep[], owner: Address, onStep: (index: number, v: StepView) => void): Promise<boolean> {
  for (const [i, s] of steps.entries()) {
    const base: StepView = { venue: s.venue, chain: s.chain, label: s.label };
    try {
      if (getAccount(config).chainId !== s.chainId) {
        onStep(i, { ...base, detail: `Switch your wallet to ${CHAINS[s.chain].chain.name}…` });
        await switchChain(config, { chainId: s.chainId as never });
      }
      if (s.spends) {
        onStep(i, { ...base, detail: "Waiting for the approval to land…" });
        await waitForAllowance(config, s, owner);
      }
      onStep(i, { ...base, detail: "Confirm in your wallet…" });
      const hash = await sendTransaction(config, { to: s.to, data: s.data, chainId: s.chainId as never });
      const explorer = `${CHAINS[s.chain].explorer}/tx/${hash}`;
      onStep(i, { ...base, detail: "Sent, confirming…", hash, explorer });
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: s.chainId as never });
      const ok = receipt.status === "success";
      onStep(i, { ...base, ok, hash, explorer, detail: ok ? "Confirmed" : "Reverted onchain. Nothing after it was sent." });
      if (!ok) return false;
    } catch (e) {
      onStep(i, { ...base, ok: false, detail: friendly(e) });
      return false;
    }
  }
  return true;
}
