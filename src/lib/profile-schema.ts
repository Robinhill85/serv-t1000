import { z } from "zod";

export const ProfileSchema = z.object({
  residence: z.enum(["UK", "EU", "US", "OTHER"]),
  amountUsd: z.number().positive().max(100_000),
  horizon: z.enum(["under_1m", "1_3m", "3_12m", "over_1y"]),
  risk: z.enum(["low", "medium", "high"]),
  instantAccess: z.boolean(),
  preference: z.enum(["stable", "mixed", "volatile"]),
  goal: z.string().max(400).default(""),
});

export const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const LegSchema = z.object({ venue: z.enum(["ixs", "base", "rh_eth", "rh_stocks"]), pct: z.number().int(), usd: z.number() });
export const GuardRequestSchema = z.object({
  source: z.enum(["simulated", "live"]),
  profile: z.object({
    preference: z.enum(["stable", "mixed", "volatile"]), risk: z.enum(["low", "medium", "high"]),
    horizon: z.enum(["under_1m", "1_3m", "3_12m", "over_1y"]), instantAccess: z.boolean(),
  }),
  legs: z.array(LegSchema).min(1).max(4),
  entry: z.object({ at: z.number(), ethPriceUsd: z.number().nullable(), idleUsd: z.number().nullable() }),
  scenario: z.object({ ethMult: z.number().min(0.2).max(3) }).nullable().default(null),
});
