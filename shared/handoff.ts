import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { actionSchema } from "./contracts.js";

// Phase 6b part 2: idle-aware coordinated handoff for Paseo agents.
export const handoffProviders = ["codex", "agy"] as const;
export const handoffProviderSchema = z.enum(handoffProviders);
export type HandoffProvider = z.infer<typeof handoffProviderSchema>;
/** Paseo provider IDs whose agents a handoff affects. Claude needs no restart. */
export const paseoProviderId: Record<HandoffProvider, string> = {
  codex: "codex",
  agy: "antigravity",
};

export const phases = [
  "waiting",
  "switching",
  "reopening",
  "done",
  "failed",
  "uncertain",
  "expired",
  "cancelled",
] as const;
export const activePhases = ["waiting", "switching", "reopening"] as const;
const text = z.string().max(512);
const id = z.string().max(128);
export const handoffSchema = z.object({
  id,
  provider: handoffProviderSchema,
  /** Saved account UUID to switch to; null for a reload-only handoff after an automatic switch. */
  target: z.uuid().nullable(),
  targetAlias: text.nullable().default(null),
  trigger: z.enum(["manual", "automaticSwitch"]),
  restartDaemon: z.boolean().default(false),
  phase: z.enum(phases),
  requestedAt: z.number().finite(),
  deadline: z.number().finite(),
  updatedAt: z.number().finite(),
  /** Number of affected Paseo agents still in a turn, or other blocking work, while waiting. */
  waitingFor: z.number().int().min(0).max(10000).default(0),
  code: z.string().max(64).nullable().default(null),
  message: text,
  affected: z.array(id).max(256).default([]),
  reopened: z.array(id).max(256).default([]),
  failedReopen: z.array(id).max(256).default([]),
  daemonOutcome: z.string().max(64).nullable().default(null),
});
export type Handoff = z.infer<typeof handoffSchema>;
export const handoffStateSchema = z.object({
  schemaVersion: z.literal(1),
  handoffs: z.object({
    codex: handoffSchema.nullable().default(null),
    agy: handoffSchema.nullable().default(null),
  }),
  /** Newest automaticSwitch event time already handled (Unix seconds). */
  eventWatermark: z.number().finite().nullable().default(null),
  /** One-time notice, for example after an unreadable state file was set aside. */
  notice: z.object({ code: z.string().max(64), message: z.string().max(1024) }).nullable().default(null),
});
export type HandoffState = z.infer<typeof handoffStateSchema>;

export const handoffSettings = defineSettings({
  id: "handoff",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Reload idle Paseo Codex agents after the poller switched Codex automatically. */
    reloadCodexAfterAutomaticSwitch: z.boolean().default(true),
    /**
     * Restart the shared Codex daemon once every Paseo Codex agent is idle: --restart-daemon on a
     * manual handoff, `codex daemon restart` while the CLI marks a restart pending after an automatic switch.
     */
    restartCodexDaemon: z.boolean().default(false),
    /** Let an automatic agy switch blocked only by agy sessions close idle Paseo agy agents and reopen them. */
    closeAgyForAutomaticSwitch: z.boolean().default(true),
    /** How long a handoff waits for running turns before it expires without changes. */
    idleWaitMinutes: z.number().int().min(1).max(240).default(30),
  }),
});
export type HandoffSettings = z.infer<typeof handoffSettings.schema>;

export const handoffStatusRpc = defineRpc({
  name: "handoff.status",
  input: z.object({}),
  output: z.object({
    handoffs: z.object({
      codex: handoffSchema.nullable(),
      agy: handoffSchema.nullable(),
    }),
    agentApi: z.boolean(),
    notice: z.object({ code: z.string().max(64), message: z.string().max(1024) }).nullable(),
  }),
});
export const handoffRequestInput = z.object({
  provider: handoffProviderSchema,
  target: z.uuid(),
});
export const handoffRequestRpc = defineRpc({
  name: "handoff.request",
  input: handoffRequestInput,
  output: z.object({ result: actionSchema, handoff: handoffSchema.nullable() }),
});
export const handoffControlInput = z.object({
  provider: handoffProviderSchema,
  action: z.enum(["cancel", "reopen", "dismiss"]),
});
export const handoffControlRpc = defineRpc({
  name: "handoff.control",
  input: handoffControlInput,
  output: z.object({ result: actionSchema, handoff: handoffSchema.nullable() }),
});
