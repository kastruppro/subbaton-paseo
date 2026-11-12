import type { Handoff } from "../shared/handoff.js";
import { activePhases } from "../shared/handoff.js";

export const handoffActive = (h: Handoff | null | undefined) =>
  !!h && (activePhases as readonly string[]).includes(h.phase);

const phaseLabel: Record<Handoff["phase"], string> = {
  waiting: "Waiting for idle",
  switching: "Switching",
  reopening: "Reopening agents",
  done: "Done",
  failed: "Failed",
  uncertain: "Result uncertain",
  expired: "Expired",
  cancelled: "Cancelled",
};
/** One readable line for the popover/settings: phase, target and the coordinator's message. */
export function handoffLine(h: Handoff): string {
  const target =
    h.trigger === "automaticSwitch"
      ? h.target ? `automatic switch to ${h.targetAlias ?? "saved account"}` : "after automatic switch"
      : `to ${h.targetAlias ?? "saved account"}`;
  return `${phaseLabel[h.phase]} (${target}): ${h.message}`;
}
export const handoffTone = (h: Handoff): "ok" | "warning" | "muted" =>
  h.phase === "done" ? "ok" : ["failed", "uncertain", "expired"].includes(h.phase) ? "warning" : "muted";
/** Which owner actions the coordinator accepts in this phase. */
export function handoffActions(h: Handoff) {
  return {
    cancel: h.phase === "waiting" || h.phase === "reopening",
    reopen: ["failed", "uncertain"].includes(h.phase) && h.affected.some((id) => !h.reopened.includes(id)),
    dismiss: !handoffActive(h),
  };
}

/** Review L5: what a When idle request will do, named before the owner confirms it. */
export function handoffEffect(provider: "codex" | "agy", alias: string, restartDaemon: boolean, idleWaitMinutes: number): string {
  const wait = `It waits up to ${idleWaitMinutes} minutes for running turns; nothing is interrupted, and if they stay busy it expires without changes.`;
  if (provider === "agy")
    return `Switch agy to ${alias} once every Paseo agy agent is idle. SubBaton then closes those idle agy agents (stops their agy sessions), switches, and reopens them with their saved conversations after a verified switch. Terminal or desktop agy sessions are never stopped; while one runs, the handoff waits. ${wait}`;
  return `Switch Codex to ${alias} once every Paseo Codex agent is idle, then reload those agents so they use the new login.${restartDaemon ? " The shared Codex daemon is restarted too (setting on): terminal Codex sessions attached to it are disconnected and need codex resume." : " The shared Codex daemon is not restarted; open Codex terminals keep the old account until restarted."} ${wait}`;
}
