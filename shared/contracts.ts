import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { defaultBinary } from "./defaults.js";
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
  inferred: z.boolean().optional().default(false),
  fetchedAt: time,
  windowSeconds: z.number().finite().nullable().optional(),
  /** 0.9.2: "models" marks the Gemini model-quota row; absent on older payloads. */
  quotaSource: z.string().max(32).optional().catch(undefined),
  /** "unknown" when no window length is known (model-quota row). */
  window: z.string().max(32).optional().catch(undefined),
});
/** 0.9.0 optional fields: anything malformed is treated as absent (unknown), never as zero or unlimited. */
const optionalBool = z.boolean().optional().catch(undefined);
const optionalNumber = z.number().finite().optional().catch(undefined);
const optionalCount = z.number().finite().min(0).optional().catch(undefined);
export const paidUsageSchema = z
  .object({
    kind: z.enum(["credits", "extraUsage"]),
    fetchedAt: z.number().finite(),
    stale: z.boolean().catch(true),
    enabled: optionalBool,
    hasCredits: optionalBool,
    unlimited: optionalBool,
    balance: z
      .union([z.string().max(64), z.number().finite().transform(String)])
      .optional()
      .catch(undefined),
    usedCredits: optionalNumber,
    monthlyLimit: optionalNumber,
    utilization: optionalNumber,
    currency: text.optional().catch(undefined),
    resetsAt: optionalNumber,
    approxLocalMessages: optionalCount,
    approxCloudMessages: optionalCount,
  })
  .optional()
  .catch(undefined);
export type PaidUsage = NonNullable<z.infer<typeof paidUsageSchema>>;
export const accountSchema = z.object({
  id: text,
  alias: text,
  email: text.nullable().default(null),
  active: z.boolean(),
  enabled: z.boolean(),
  health: z
    .string()
    .max(128)
    .transform((v) =>
      [
        "ok",
        "needsLogin",
        "attention",
        "deviceBlocked",
        "quarantined",
      ].includes(v)
        ? v
        : "unknown",
    ),
  plan: text.nullable().default(null),
  loginExpiresAt: time.default(null),
  usageStatus: text,
  summaryStatus: text.nullable().optional(),
  warnings: z.array(text).max(8).optional(),
  windows: z.array(windowSchema).max(256),
  paidUsage: paidUsageSchema,
  attentionSince: optionalNumber,
  /** Codex: the official CLI refused this login with a usage limit and SubBaton recorded it (Unix seconds, while live). */
  limitObservedAt: optionalNumber,
  resetCreditsAvailable: z
    .number()
    .int()
    .min(0)
    .optional()
    .catch(undefined),
});
/** Optional contract additions; anything malformed is treated as absent so older CLIs keep working. */
const autoSchema = z
  .object({
    enabled: z.boolean(),
    paused: z.boolean(),
    pauseReason: text.nullable().optional(),
    pauseId: text.nullable().optional(),
    message: text.nullable().optional(),
    lastAutomaticSwitchAt: z.number().finite().nullable().optional(),
  })
  .nullable()
  .optional()
  .catch(undefined);
const providerStatusSchema = z.preprocess(
  (value) => {
    if (
      value &&
      typeof value === "object" &&
      "provider" in value &&
      typeof value.provider === "string" &&
      !providerSchema.safeParse(value.provider).success
    )
      return { provider: "unknown", cacheStatus: "unknown", accounts: [] };
    return value;
  },
  z.object({
    provider: z.enum(["claude", "codex", "agy", "unknown"]),
    cacheStatus: z
      .string()
      .max(128)
      .transform((v) =>
        ["available", "missing", "unavailable"].includes(v) ? v : "unknown",
      ),
    updatedAt: z.number().finite().optional(),
    accounts: z.array(accountSchema).max(256),
    auto: autoSchema,
    daemonRestartPending: z.boolean().nullable().optional().catch(undefined),
    daemonRestartPendingSince: z
      .number()
      .finite()
      .nullable()
      .optional()
      .catch(undefined),
  }),
);
export const statusSchema = z.object({
  cacheOnly: z.literal(true),
  generatedAt: z.number().finite(),
  providers: z
    .array(providerStatusSchema)
    .max(32)
    .transform((rows) =>
      rows.filter(
        (row, index) =>
          rows.findIndex((other) => other.provider === row.provider) === index,
      ),
    ),
});
export type Status = z.infer<typeof statusSchema>;
export type Account = z.infer<typeof accountSchema>;
export type ProviderStatus = Status["providers"][number];
export type Window = z.infer<typeof windowSchema>;
export const actionSchema = z.object({
  outcome: z.enum(["success", "unchanged", "uncertain", "error"]),
  code: text,
  message: text,
  cause: text.optional(),
});
export type ActionResult = z.infer<typeof actionSchema>;
export const statusResultSchema = z.object({
  ok: z.boolean(),
  data: statusSchema.nullable(),
  error: actionSchema.nullable(),
});
export type StatusResult = z.infer<typeof statusResultSchema>;
export const statusRpc = defineRpc({
  name: "status",
  input: z.object({}),
  output: statusResultSchema,
});
export const switchInput = z.object({
  provider: providerSchema,
  target: z.uuid(),
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
/** Explicit click only: a CLI dry run names the target of "Switch to best account" (Codex, agy). */
export const strategyPreviewInput = z.object({
  provider: z.enum(["codex", "agy"]),
  strategy: z.literal("best"),
});
export const strategyPreviewResult = z.object({
  outcome: z.enum(["target", "unchanged", "none", "error"]),
  message: text,
  target: z.uuid().optional(),
  alias: text.optional(),
});
export type StrategyPreview = z.infer<typeof strategyPreviewResult>;
export const strategyPreviewRpc = defineRpc({
  name: "strategy.preview",
  input: strategyPreviewInput,
  output: strategyPreviewResult,
});
export const refreshAccountInput = z.object({ provider: providerSchema, account: z.uuid() });
export const refreshAccountRpc = defineRpc({
  name: "refresh.account",
  input: refreshAccountInput,
  output: actionSchema,
});
export const refreshRpc = defineRpc({
  name: "refresh",
  input: z.object({}),
  output: z
    .array(
      z.object({ provider: providerSchema.nullable(), result: actionSchema }),
    )
    .max(3),
});
export const hostSettings = defineSettings({
  id: "host",
  scope: "host",
  version: 2,
  migrate(values) {
    if (values && typeof values === "object" && "binaryPath" in values &&
        values.binaryPath === "/Users/Shared/subbaton/subbaton")
      return { ...values, binaryPath: defaultBinary };
    return values;
  },
  schema: z.object({
    allowPathLookup: z.boolean().default(false),
    binaryPath: z.string().min(1).max(4096).default(defaultBinary),
  }),
});
export const maxFooterItems = 6;
export const displaySchema = z
  .object({
    items: z
      .preprocess(
        (value) => (Array.isArray(value) ? value.slice(0, maxFooterItems) : value),
        z.array(
          z.object({
            provider: providerSchema,
            windowId: z.string().min(1).max(512),
          }),
        ),
      )
      .default([
        { provider: "claude", windowId: "five_hour" },
        { provider: "codex", windowId: "codex:primary_window" },
        { provider: "agy", windowId: "gemini:5h" },
      ]),
    warning: z.number().min(1).max(99).default(80),
    danger: z.number().min(1).max(100).default(100),
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
