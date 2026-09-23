import { describe, expect, it } from "vitest";
import { interpret, parseAmount } from "./interpret";

describe("parseAmount", () => {
  it("reads 'all' phrasings as the full idle balance", () => {
    expect(parseAmount("all is fine", 180.92)).toEqual({ value: 180.92, label: "All of it ($180.92)" });
    expect(parseAmount("put everything to work", 180.92)?.value).toBe(180.92);
  });
  it("reads numbers, dollars, k and commas", () => {
    expect(parseAmount("$150", 500)?.value).toBe(150);
    expect(parseAmount("about 200 dollars", 500)?.value).toBe(200);
    expect(parseAmount("1,250", 5000)?.value).toBe(1250);
    expect(parseAmount("2k", 5000)?.value).toBe(2000);
  });
  it("reads fractions and percentages of the idle balance", () => {
    expect(parseAmount("half", 300)?.value).toBe(150);
    expect(parseAmount("a quarter please", 300)?.value).toBe(75);
    expect(parseAmount("50%", 300)?.value).toBe(150);
  });
  it("returns null when there is no amount", () => {
    expect(parseAmount("not sure yet", 300)).toBeNull();
    expect(parseAmount("all", 0)).toBeNull();
  });
});

describe("interpret (rule paths, no network)", () => {
  it("takes exact option labels without calling the model", async () => {
    expect(await interpret("residence", "uk", { idleUsd: 0 })).toMatchObject({ ok: true, value: "UK", via: "rule" });
    expect(await interpret("instantAccess", "nah", { idleUsd: 0 })).toMatchObject({ ok: true, value: false, via: "rule" });
    expect(await interpret("risk", "High", { idleUsd: 0 })).toMatchObject({ ok: true, value: "high", via: "rule" });
  });
  it("asks again when an amount has no number or keyword", async () => {
    expect(await interpret("amountUsd", "whatever you think", { idleUsd: 300 })).toMatchObject({ ok: false });
  });
});
