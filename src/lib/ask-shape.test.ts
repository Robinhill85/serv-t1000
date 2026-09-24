import { describe, expect, it } from "vitest";
import { looksLikeQuestion, rateAllow } from "./ask-shape";

describe("looksLikeQuestion", () => {
  it("catches questions", () => {
    for (const q of ["is $2 enough?", "why no IXS", "how does guard work", "what is Jev", "can I withdraw any time", "explain the IXS vault", "?"]) expect(looksLikeQuestion(q)).toBe(true);
  });
  it("leaves answers to the steps alone", () => {
    for (const a of ["all is fine", "about half a year", "UK", "I live in London", "No, it can wait", "mostly stables, a little ETH", "Park it for 6 months, I'd like about 10% in ETH for upside", "half", "why"]) expect(looksLikeQuestion(a)).toBe(false);
  });
});

describe("rateAllow", () => {
  it("allows up to the limit inside the window, then refuses until it slides", () => {
    const store = new Map<string, number[]>();
    for (let i = 0; i < 3; i++) expect(rateAllow(store, "ip", 1000 + i, 3, 60_000)).toBe(true);
    expect(rateAllow(store, "ip", 2000, 3, 60_000)).toBe(false);
    expect(rateAllow(store, "other", 2000, 3, 60_000)).toBe(true);
    expect(rateAllow(store, "ip", 70_000, 3, 60_000)).toBe(true);
  });
});
