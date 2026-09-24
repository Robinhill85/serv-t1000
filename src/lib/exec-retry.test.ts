import { describe, expect, it } from "vitest";
import { isRetryableEstimateError } from "./exec-retry";

describe("isRetryableEstimateError", () => {
  it("retries the first live run's failure: an estimate on a node that had not seen the approve", () => {
    const msg = "Execution reverted with reason: ERC20: transfer amount exceeds allowance. Estimate Gas Arguments: from: 0x2C12CF9dcb6C4958216e7eCe4c71a2Ebc3db358a to: 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61 data: 0x6e553f65";
    expect(isRetryableEstimateError(msg)).toBe(true);
    expect(isRetryableEstimateError("Execution reverted with reason: STF. Estimate Gas Arguments: from: 0x…")).toBe(true);
  });
  it("never retries anything that may have been broadcast, or a revert that lag cannot explain", () => {
    expect(isRetryableEstimateError("nonce too low")).toBe(false);
    expect(isRetryableEstimateError("replacement transaction underpriced")).toBe(false);
    expect(isRetryableEstimateError("Timed out while waiting for transaction with hash 0xabc to be confirmed.")).toBe(false);
    expect(isRetryableEstimateError("Execution reverted with reason: Pausable: paused. Estimate Gas Arguments: from: 0x…")).toBe(false);
    expect(isRetryableEstimateError("ERC20: transfer amount exceeds allowance")).toBe(false); // not from an estimate
  });
});
