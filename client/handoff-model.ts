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
  const target = h.trigger === "automaticSwitch" ? "after automatic switch" : `to ${h.targetAlias ?? "saved account"}`;
  return `${phaseLabel[h.phase]} (${target}): ${h.message}`;
}
export const handoffTone = (h: Handoff): "ok" | "warning" | "muted" =>
  h.phase === "done" ? "ok" : ["failed", "uncertain", "expired"].includes(h.phase) ? "warning" : "muted";
/** Which owner actions the coordinator accepts in this phase. */
export function handoffActions(h: Handoff) {
  return {
    cancel: h.phase === "waiting",
    reopen: ["failed", "uncertain"].includes(h.phase) && h.affected.some((id) => !h.reopened.includes(id)),
    dismiss: !handoffActive(h),
  };
}
