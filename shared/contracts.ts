import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export const providerSchema = z.enum(["claude", "codex", "agy"]);
export type Provider = z.infer<typeof providerSchema>;
const text = z.string().max(512);
const time = z.number().finite().nullable();
export const windowSchema = z.object({
  id: text,
  label: text,
  usedPercent: z.number().min(0).max(100).nullable(),
  resetsAt: time,
  stale: z.boolean(),
  fetchedAt: time,
});
export const accountSchema = z.object({
  id: text,
  alias: text,
  email: text.nullable(),
  active: z.boolean(),
  enabled: z.boolean(),
  health:z.string().max(128).transform(v=>["ok","needsLogin","attention","deviceBlocked","quarantined"].includes(v)?v:"unknown"),
  plan: text.nullable(),
  loginExpiresAt: time,
  usageStatus: text,
  windows: z.array(windowSchema).max(256),
});
const providerStatusSchema=z.preprocess(value=>{
  if(value&&typeof value==="object"&&"provider"in value&&typeof value.provider==="string"&&!providerSchema.safeParse(value.provider).success)return {provider:"unknown",cacheStatus:"unknown",accounts:[]};
  return value;
},z.object({
  provider:z.enum(["claude","codex","agy","unknown"]),
  cacheStatus:z.string().max(128).transform(v=>["available","missing","unavailable"].includes(v)?v:"unknown"),
  updatedAt:z.number().finite().optional(),
  accounts:z.array(accountSchema).max(256),
}));
export const statusSchema=z.object({cacheOnly:z.literal(true),generatedAt:z.number().finite(),providers:z.array(providerStatusSchema).max(32).transform(rows=>rows.filter((row,index)=>rows.findIndex(other=>other.provider===row.provider)===index))});
export type Status = z.infer<typeof statusSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Window = z.infer<typeof windowSchema>;
export const actionSchema = z.object({
  outcome: z.enum(["success", "unchanged", "uncertain", "error"]),
  code: text,
  message: text,
});
export type ActionResult = z.infer<typeof actionSchema>;
export const statusResultSchema = z.object({
  ok: z.boolean(),
  data: statusSchema.nullable(),
  error: actionSchema.nullable(),
});
export type StatusResult=z.infer<typeof statusResultSchema>;
export const statusRpc = defineRpc({
  name: "status",
  input: z.object({}),
  output: statusResultSchema,
});
export const switchInput = z.object({
  provider: providerSchema,
  target:z.uuid(),
});
export const switchRpc = defineRpc({
  name: "switch",
  input: switchInput,
  output: actionSchema,
});
export const strategyInput = z.object({
  provider: providerSchema,
  strategy: z.enum(["best", "next-available"]),
});
export const strategyRpc = defineRpc({
  name: "strategy",
  input: strategyInput,
  output: actionSchema,
});
export const refreshRpc = defineRpc({
  name: "refresh",
  input: z.object({}),
  output: z
    .array(z.object({ provider: providerSchema.nullable(), result: actionSchema }))
    .max(3),
});
export const hostSettings = defineSettings({
  id: "host",
  scope: "host",
  version: 1,
  schema: z.object({
    allowPathLookup:z.boolean().default(false),
    binaryPath: z
      .string()
      .min(1)
      .max(4096)
      .default("/Users/Shared/subbaton/subbaton"),
  }),
});
export const displaySchema = z
  .object({
    items: z
      .array(
        z.object({
          provider: providerSchema,
          windowId: z.string().min(1).max(512),
        }),
      )
      .max(24)
      .default([
        { provider: "claude", windowId: "five_hour" },
        { provider: "codex", windowId: "codex:primary_window" },
      ]),
    warning: z.number().min(1).max(99).default(75),
    danger: z.number().min(1).max(100).default(90),
  })
  .refine((v) => v.warning < v.danger, {
    message: "Warning must be below danger.",
  });
export const displaySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: displaySchema,
});
export type DisplaySettings = z.infer<typeof displaySchema>;
