// Live-run resilience. Public RPCs behind a load balancer can answer from a node that has not yet seen the
// transaction that just confirmed on another node (first live run, 24 Sep: Base deposit estimated against a node
// without the approve, "ERC20: transfer amount exceeds allowance").

/**
 * True when a send failed while estimating gas: AgentKit estimates before it signs, so nothing was broadcast
 * and retrying cannot double-send. Only lag-shaped reverts qualify; a real revert fails the same way three times.
 */
export function isRetryableEstimateError(message: string): boolean {
  if (!/Estimate Gas Arguments|estimateGas/i.test(message)) return false;
  return /exceeds allowance|insufficient allowance|allowance|transfer amount exceeds balance|\bSTF\b/i.test(message);
}

export const SEND_ATTEMPTS = 4;
export const RETRY_DELAY_MS = 3000;
