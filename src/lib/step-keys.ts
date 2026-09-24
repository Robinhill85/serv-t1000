// Stable step keys for wallet runs (venue:action). A key in a run's "done" list is confirmed onchain and is never
// sent again; the final key of a leg or move means its funds were spent.
import type { VenueId } from "./config";

/** The step that completes each venue's deposit leg. */
export const LEG_DONE_KEY: Record<VenueId, string> = { base: "base:deposit", ixs: "ixs:deposit", rh_eth: "rh_eth:buy", rh_stocks: "rh_stocks:buy" };

/** The step that completes a Guard move: a deposit leg for idle -> venue, the venue's exit for venue -> idle. */
export function moveDoneKey(m: { from: string; to: string }): string {
  if (m.from === "idle") return LEG_DONE_KEY[m.to as VenueId] ?? `${m.to}:deposit`;
  return ({ base: "base:withdraw", rh_eth: "rh_eth:sell", ixs: "ixs:redeem" } as Record<string, string>)[m.from] ?? `${m.from}:exit`;
}
