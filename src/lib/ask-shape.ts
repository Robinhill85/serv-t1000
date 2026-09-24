// "Ask T1000": telling a question apart from an answer to the current step, and a small rate limiter.
// Client-safe (no server imports).

const QUESTION_START = /^(what|what's|whats|why|how|can|could|is|isn't|are|should|do|does|did|will|would|which|when|where|who|whose|explain|tell me|help|wait,? what)\b/i;

/** "is $2 enough?", "why no IXS", "how does guard work" -> true; "all is fine", "about half a year", "UK" -> false. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.endsWith("?")) return true;
  return QUESTION_START.test(t) && t.split(/\s+/).length >= 3;
}

/** Sliding-window limiter: true (and the hit is recorded) while `key` has fewer than `limit` hits in `windowMs`. */
export function rateAllow(store: Map<string, number[]>, key: string, now: number, limit = 20, windowMs = 10 * 60_000): boolean {
  const hits = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) { store.set(key, hits); return false; }
  hits.push(now);
  store.set(key, hits);
  if (store.size > 5000) for (const k of [...store.keys()].slice(0, 1000)) store.delete(k); // bound memory
  return true;
}

export const ASK_SUGGESTIONS = ["scan", "demo", "guide", "restart", "withdraw", "none"] as const;
export type AskSuggestion = (typeof ASK_SUGGESTIONS)[number];
