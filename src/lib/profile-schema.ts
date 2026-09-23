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
