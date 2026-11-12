import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { actionSchema, providerSchema } from "./contracts.js";

// Phase 6b: CLI-backed settings, poller, events and auto plan. The CLI owns every value and rule;
// the plugin validates shapes and bounds, renders the CLI's field metadata and sends batches.
const text = z.string().max(512);
const longText = z.string().max(2048);
const time = z.number().finite().nullable();
export const identifierPattern = /^[A-Za-z0-9_:.-]{1,100}$/;
export const identifier = z.string().regex(identifierPattern);
// Values placed in CLI argv never start with "-", so they cannot be read as a flag (review L1).
export const revisionSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
export const argvIdentifier = z.string().regex(/^[A-Za-z0-9_:.][A-Za-z0-9_:.-]{0,99}$/);
const known = <T extends string>(values: readonly T[]) =>
  z
    .string()
    .max(128)
    .transform((v): T | "unknown" =>
      (values as readonly string[]).includes(v) ? (v as T) : "unknown",
    );

export const dictionarySchema = z
  .record(identifier, z.number().finite().nullable())
  .refine((v) => Object.keys(v).length <= 256);
export const leafSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.null(),
  text,
  z.array(text).max(256),
  dictionarySchema,
]);
export type Leaf = z.infer<typeof leafSchema>;
export const fieldTypes = [
  "boolean",
  "number",
  "integer",
  "string",
  "object",
  "array",
] as const;
export const settingsFieldSchema = z.object({
  path: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9_.<>-]+$/),
  type: known(fieldTypes),
  title: text,
  description: longText.default(""),
  unit: text.default("none"),
  scope: text.default(""),
  nullable: z.boolean().default(false),
  runtime: known(["active", "persistedOnly"] as const),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  enum: z.array(text).max(32).optional(),
  enumDescriptions: z.record(text, text).optional(),
  runtimeDetail: longText.optional(),
  knownKeys: z.array(identifier).max(512).optional(),
  allowedRanges: z
    .array(z.tuple([z.number().finite(), z.number().finite()]))
    .max(8)
    .optional(),
  default: leafSchema.optional(),
});
export type SettingsField = z.infer<typeof settingsFieldSchema>;
export const autoSummarySchema = z.object({
  paused: z.boolean(),
  pauseReason: text.nullable().default(null),
  pausedAt: time.default(null),
  pauseId: z.preprocess((v) => (argvIdentifier.safeParse(v).success ? v : null), argvIdentifier.nullable()).default(null),
  lastAutomaticSwitchAt: time.default(null),
  recentAutomaticSwitches: z.number().int().min(0).max(10000).default(0),
  flapLimit: z.number().int().min(0).max(10000).nullable().default(null),
});
export const actionNames = [
  "releaseQuarantine",
  "resumeAuto",
  "releaseDeviceBlock",
] as const;
const flat = z.record(z.string().max(256), leafSchema);
export const settingsAccountSchema = z.object({
  id: identifier,
  alias: text,
  quarantined: z.boolean(),
  deviceBlocked: z.boolean(),
  needsLogin: z.boolean(),
  values: flat,
  effective: flat,
});
export type SettingsAccount = z.infer<typeof settingsAccountSchema>;
export const settingsSectionSchema = z.object({
  ok: z.literal(true),
  provider: providerSchema,
  revision: revisionSchema,
  exists: z.boolean(),
  readOnly: z.boolean(),
  migrationRequired: z.boolean(),
  newerSchema: z.boolean(),
  fields: z.array(settingsFieldSchema).max(128),
  values: flat,
  defaults: flat,
  effective: flat,
  accounts: z.array(settingsAccountSchema).max(256),
  actions: z.array(z.enum(actionNames)).max(8),
  auto: autoSummarySchema,
});
export type SettingsSection = z.infer<typeof settingsSectionSchema>;
export const settingsSectionErrorSchema = z.object({
  ok: z.literal(false),
  provider: providerSchema,
  error: actionSchema,
});
export const pollerSummarySchema = z.object({
  installed: z.boolean().nullable(),
  lastTickAt: time,
  stale: z.boolean(),
  unavailable: z.boolean().default(false),
});
export const settingsResultSchema = z.object({
  ok: z.boolean(),
  data: z
    .object({
      providers: z
        .array(z.union([settingsSectionSchema, settingsSectionErrorSchema]))
        .max(3),
      poller: pollerSummarySchema.nullable(),
    })
    .nullable(),
  error: actionSchema.nullable(),
});
export type SettingsResult = z.infer<typeof settingsResultSchema>;
export const settingsGetInput = z.object({ fresh: z.boolean().optional() });
export const settingsGetRpc = defineRpc({
  name: "settings.get",
  input: settingsGetInput,
  output: settingsResultSchema,
});

// Paths are segments relative to the provider; the server encodes them as a JSON Pointer.
export const changeSchema = z.object({
  path: z.array(identifier).min(1).max(6),
  value: leafSchema,
});
export type SettingsChange = z.infer<typeof changeSchema>;
export const settingsSetInput = z.object({
  provider: providerSchema,
  expectedRevision: revisionSchema,
  changes: z.array(changeSchema).min(1).max(256),
});
export const mutationResultSchema = z.object({
  result: actionSchema,
  section: settingsSectionSchema.nullable(),
});
export type MutationResult = z.infer<typeof mutationResultSchema>;
export const settingsSetRpc = defineRpc({
  name: "settings.set",
  input: settingsSetInput,
  output: mutationResultSchema,
});
export const settingsActionInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("releaseQuarantine"),
    provider: providerSchema,
    account: argvIdentifier,
    expectedRevision: revisionSchema,
  }),
  z.object({
    action: z.literal("releaseDeviceBlock"),
    provider: z.literal("codex"),
    account: argvIdentifier,
    expectedRevision: revisionSchema,
  }),
  z.object({
    action: z.literal("resumeAuto"),
    provider: providerSchema,
    pauseId: argvIdentifier,
    expectedRevision: revisionSchema,
  }),
]);
export type SettingsActionInput = z.infer<typeof settingsActionInput>;
export const settingsActionRpc = defineRpc({
  name: "settings.action",
  input: settingsActionInput,
  output: mutationResultSchema,
});

const counter = z.number().int().min(0).max(1_000_000).optional();
export const pollerProviderSchema = z.object({
  outcome: text.optional(),
  error: text.optional(),
  auto: text.optional(),
  checked: counter,
  cached: counter,
  skipped: counter,
  failed: counter,
  lastTickAt: z.number().finite().optional(),
});
export const pollerStatusSchema = z.object({
  installed: z.boolean().nullable(),
  loaded: z.boolean().nullable().default(null),
  lastTickAt: time,
  stale: z.boolean(),
  binary: z.string().max(4096).nullable().default(null),
  tickSeconds: z.number().finite().nullable().default(null),
  /** Provider-home overrides the LaunchAgent is pinned to (paths only); null when not installed. */
  pinnedEnvironment: z
    .partialRecord(z.enum(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]), z.string().max(4096))
    .nullable()
    .catch(null)
    .default(null),
  environmentSource: z.string().max(32).optional(),
  providers: z
    .record(z.string().max(16), pollerProviderSchema)
    .transform((rows) =>
      Object.fromEntries(
        Object.entries(rows).filter(
          ([key]) => providerSchema.safeParse(key).success,
        ),
      ) as Partial<Record<"claude" | "codex" | "agy", z.infer<typeof pollerProviderSchema>>>,
    )
    .default({}),
});
export type PollerStatus = z.infer<typeof pollerStatusSchema>;
export const pollerStatusResultSchema = z.object({
  ok: z.boolean(),
  data: pollerStatusSchema.nullable(),
  error: actionSchema.nullable(),
});
export const pollerStatusRpc = defineRpc({
  name: "poller.status",
  input: z.object({}),
  output: pollerStatusResultSchema,
});
export const pollerLifecycleInput = z.object({
  action: z.enum(["install", "uninstall"]),
  /** keep (CLI default) leaves the pinned provider homes; current re-pins from the Paseo daemon; none removes them. */
  environment: z.enum(["keep", "current", "none"]).default("keep"),
});
export const pollerLifecycleRpc = defineRpc({
  name: "poller.lifecycle",
  input: pollerLifecycleInput,
  output: z.object({ result: actionSchema, status: pollerStatusSchema.nullable() }),
});

export const eventKinds = [
  "automaticSwitch",
  "switchFailed",
  "needsLogin",
  "deviceBlocked",
  "paused",
  "quarantineReleased",
  "deviceBlockReleased",
] as const;
export const eventSchema = z.object({
  id: text,
  at: z.number().finite(),
  provider: z
    .string()
    .max(16)
    .transform((v) => (providerSchema.safeParse(v).success ? (v as "claude" | "codex" | "agy") : "unknown" as const)),
  kind: known(eventKinds),
  account: text.optional(),
  alias: text.optional(),
  target: text.optional(),
  targetAlias: text.optional(),
  reason: text.optional(),
  transaction: text.optional(),
});
export type SubBatonEvent = z.infer<typeof eventSchema>;
export const eventsInput = z.object({
  since: z.number().finite().min(0).optional(),
});
export const eventsResultSchema = z.object({
  ok: z.boolean(),
  data: z.object({ events: z.array(eventSchema).max(500) }).nullable(),
  error: actionSchema.nullable(),
});
export const eventsRpc = defineRpc({
  name: "events.list",
  input: eventsInput,
  output: eventsResultSchema,
});

const optionalNumber = z.number().finite().optional();
export const planWindowSchema = z.object({
  id: text,
  kind: text,
  model: text.nullable().optional(),
  usedPercent: optionalNumber,
  threshold: z
    .object({ value: z.number().finite(), source: text })
    .optional(),
  fetchedAt: optionalNumber,
  resetsAt: optionalNumber,
  state: text,
  inferred: z.boolean().default(false),
});
export const planCandidateSchema = z.object({
  id: text,
  alias: text,
  eligible: z.boolean(),
  reasons: z.array(text).max(32),
  windows: z.array(planWindowSchema).max(128),
  headroom: optionalNumber,
  accessTokenExpired: z.boolean().default(false),
  forecast: z
    .object({
      window: text.optional(),
      remainingQuota: optionalNumber,
      consumableQuota: optionalNumber,
      resetAt: optionalNumber,
      predictedUnused: optionalNumber,
      priority: z.boolean().default(false),
    })
    .default({ priority: false }),
});
export const autoPlanSchema = z.object({
  provider: providerSchema,
  evaluatedAt: z.number().finite(),
  executionEnabled: z.boolean(),
  autoEnabled: z.boolean(),
  processState: text,
  sampleCount: z.number().int().min(0).max(100000).default(0),
  pauseMessage: longText.optional(),
  decision: z.object({
    action: text,
    target: text.nullable().optional(),
    reason: text,
  }),
  why: z.object({
    candidates: z.array(planCandidateSchema).max(256),
    rate: z.object({
      percentPerHour: optionalNumber,
      confidence: text,
      sampleCount: z.number().int().min(0).max(100000),
    }),
    effectiveStrategy: text,
    sequences: z
      .array(
        z.object({
          order: z.array(text).max(8),
          expiredQuota: z.number().finite(),
        }),
      )
      .max(64),
    sequenceBound: z.number().int().min(0).max(64).default(4),
    sequenceAccounts: z.array(text).max(8).default([]),
    weeklyPriorityAccounts: z.array(text).max(256).default([]),
    proposedTarget: text.nullable().optional(),
    cooldown: z.object({
      remainingSeconds: z.number().finite(),
      overridden: z.boolean(),
      passed: z.boolean(),
    }),
    margin: z.object({
      required: z.number().finite(),
      headroomImprovement: optionalNumber,
      wasteImprovement: optionalNumber,
      passed: z.boolean(),
    }),
    finalReason: text,
  }),
  auto: autoSummarySchema,
});
export type AutoPlan = z.infer<typeof autoPlanSchema>;
export const autoPlanInput = z.object({ provider: providerSchema });
export const autoPlanRpc = defineRpc({
  name: "auto.plan",
  input: autoPlanInput,
  output: z.object({
    ok: z.boolean(),
    data: autoPlanSchema.nullable(),
    error: actionSchema.nullable(),
  }),
});
