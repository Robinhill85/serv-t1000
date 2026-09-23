import { createPublicClient, fallback, http, type PublicClient, type Transport } from "viem";
import { CHAINS, rpcUrl, type ChainKey } from "./config";

const cache = new Map<ChainKey, PublicClient>();

/** Alchemy first, then the chain's public RPC (if it has a usable one). Shared by read and wallet clients. */
export function transport(key: ChainKey): Transport {
  const primary = http(rpcUrl(key), { timeout: 10_000, retryCount: 1 });
  const pubs = CHAINS[key].publicRpcs ?? [];
  return pubs.length ? fallback([primary, ...pubs.map((u) => http(u, { timeout: 10_000 }))]) : primary;
}

export function publicClient(key: ChainKey): PublicClient {
  let c = cache.get(key);
  if (!c) {
    c = createPublicClient({ chain: CHAINS[key].chain, transport: transport(key) }) as PublicClient;
    cache.set(key, c);
  }
  return c;
}

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
