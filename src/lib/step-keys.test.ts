import { describe, expect, it } from "vitest";
import { LEG_DONE_KEY, moveDoneKey } from "./step-keys";
import { ASK_SUGGESTIONS } from "./ask-shape";

describe("step keys", () => {
  it("names the step that spends each deposit leg", () => {
    expect(LEG_DONE_KEY.base).toBe("base:deposit");
    expect(LEG_DONE_KEY.ixs).toBe("ixs:deposit");
    expect(LEG_DONE_KEY.rh_eth).toBe("rh_eth:buy");
  });
  it("maps Guard moves to their completing step", () => {
    expect(moveDoneKey({ from: "idle", to: "base" })).toBe("base:deposit");
    expect(moveDoneKey({ from: "base", to: "idle" })).toBe("base:withdraw");
    expect(moveDoneKey({ from: "rh_eth", to: "idle" })).toBe("rh_eth:sell");
    expect(moveDoneKey({ from: "ixs", to: "idle" })).toBe("ixs:redeem");
  });
  it("offers withdraw as an Ask T1000 suggestion", () => {
    expect(ASK_SUGGESTIONS).toContain("withdraw");
  });
});
