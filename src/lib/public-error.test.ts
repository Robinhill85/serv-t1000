import { HttpRequestError } from "viem";
import { describe, expect, it } from "vitest";
import { publicError, redactUrls } from "./public-error";
import { clientIp, overLimit } from "./limits";

describe("publicError", () => {
  it("never returns an Alchemy key from a viem HTTP error", () => {
    const e = new HttpRequestError({ url: "https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY1234567890", status: 429, body: { method: "eth_call" } });
    expect(e.message).toContain("SECRETKEY"); // what used to reach the browser
    expect(publicError(e, "failed")).not.toContain("SECRETKEY");
    expect(publicError(e, "failed")).toBe("HTTP request failed.");
  });
  it("redacts keyed URLs in plain errors too", () => {
    const e = new Error("fetch failed for https://base-mainnet.g.alchemy.com/v2/abcDEF123456_-xyz");
    expect(publicError(e, "failed")).toBe("fetch failed for https://base-mainnet.g.alchemy.com/v2/<redacted>");
    expect(redactUrls("https://rpc.mainnet.chain.robinhood.com")).toBe("https://rpc.mainnet.chain.robinhood.com");
  });
  it("falls back for non-errors", () => {
    expect(publicError("boom", "failed")).toBe("failed");
  });
});

describe("overLimit", () => {
  it("allows up to the limit per visitor, then answers 429", () => {
    const store = new Map<string, number[]>();
    const req = new Request("http://x/api/decide", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
    expect(clientIp(req)).toBe("203.0.113.7");
    for (let i = 0; i < 6; i++) expect(overLimit(store, req, 6, "slow down")).toBeNull();
    expect(overLimit(store, req, 6, "slow down")?.status).toBe(429);
    const other = new Request("http://x/api/decide", { headers: { "x-forwarded-for": "198.51.100.2" } });
    expect(overLimit(store, other, 6, "slow down")).toBeNull();
  });
});
