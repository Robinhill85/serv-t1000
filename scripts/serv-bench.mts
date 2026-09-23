// Which SERV feature costs the latency, and why do some calls come back empty?
// `npx tsx --env-file=.env.local scripts/serv-bench.mts [runs]`
import OpenAI from "openai";
import { SYSTEM_PROMPT, decisionInput, SERV_BASE_URL } from "../src/lib/decide.ts";
import { eligibility, minPctFor, volatileCap } from "../src/lib/rulebook.ts";
import { getSignals } from "../src/lib/signals.ts";
import { jevScores } from "../src/lib/jev.ts";
import { VENUE_IDS } from "../src/lib/config.ts";
import type { Profile } from "../src/lib/types.ts";

const profile: Profile = { residence: "UK", amountUsd: 300, horizon: "3_12m", risk: "medium", instantAccess: false, preference: "mixed", goal: "Park my idle stables for the next 6 months, some upside is fine" };
const runs = Number(process.argv[2] ?? 2);
const s = await getSignals();
const elig = eligibility(profile, { ixs: { paused: s.ixs.paused, whitelistEnabled: s.ixs.whitelistEnabled, agentWhitelisted: false }, usMarketOpen: s.market.usMarketOpen });
const jev = await jevScores(profile, s);
const minPct = Object.fromEntries(VENUE_IDS.map((id) => [id, minPctFor(id, profile.amountUsd)])) as never;
const input = decisionInput(profile, elig, s, jev, minPct, volatileCap(profile));
const client = new OpenAI({ baseURL: SERV_BASE_URL, apiKey: process.env.SERV_API_KEY!, timeout: 120_000, maxRetries: 0 });

const guard = { type: "function" as const, function: { name: "serv_prompt_guard" } };
const shadow = { type: "function" as const, function: { name: "serv_shadow_agent", parameters: { type: "object", properties: { max_iterations: { type: "integer", default: Number(process.env.SHADOW_ITER ?? 3) } } } } };
const variants: { name: string; model: string; tools?: unknown[]; raw?: boolean }[] = [
  { name: "raw (T-800)", model: "gpt-5.4-mini", raw: true },
  { name: "serv plain", model: "gpt-5.4-mini" },
  { name: "serv +guard", model: "gpt-5.4-mini", tools: [guard] },
  { name: "serv multipath", model: "gpt-5.4-mini-serv-multipath" },
  { name: "serv +shadow", model: "gpt-5.4-mini", tools: [shadow] },
  { name: "serv full", model: "gpt-5.4-mini-serv-multipath", tools: [guard, shadow] },
];

async function one(v: (typeof variants)[number]) {
  const t0 = Date.now();
  try {
    const res = await client.chat.completions.create(
      {
        model: v.model,
        reasoning_effort: "low",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "Answer in JSON. " + JSON.stringify(input) }],
        response_format: { type: "json_object" },
        ...(v.tools ? { tools: v.tools as never } : {}),
      },
      v.raw ? { headers: { "x-openserv-disable-braid": "true" } } : undefined,
    );
    const c = res.choices[0];
    const txt = c?.message?.content ?? "";
    let parsed = false;
    try { JSON.parse(txt); parsed = true; } catch { /* */ }
    return { ms: Date.now() - t0, finish: c?.finish_reason, len: txt.length, parsed, tokens: res.usage?.completion_tokens, head: parsed ? "" : txt.slice(0, 160).replace(/\s+/g, " ") };
  } catch (e) {
    return { ms: Date.now() - t0, error: e instanceof Error ? e.message.slice(0, 160) : String(e) };
  }
}

const results = await Promise.all(variants.flatMap((v) => Array.from({ length: runs }, () => one(v).then((r) => ({ v: v.name, ...r })))));
for (const v of variants) {
  const rs = results.filter((r) => r.v === v.name);
  console.log(v.name.padEnd(16), rs.map((r) => ("error" in r && r.error) ? `ERR ${r.error}` : `${(r.ms / 1000).toFixed(1)}s ${r.finish} len=${(r as { len: number }).len}${(r as { parsed: boolean }).parsed ? "" : " UNPARSED:" + (r as { head: string }).head}`).join(" | "));
}
