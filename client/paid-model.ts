import type { Account, PaidUsage, Provider } from "../shared/contracts.js";
import { relativeAge } from "./display.js";

/** Paid availability is fresh for at most 180 seconds, even if the CLI's flag says fresh. */
export const paidFreshSeconds = 180;
export const paidStale = (paid: PaidUsage, now = Date.now() / 1000) =>
  paid.stale || !(now - paid.fetchedAt <= paidFreshSeconds);

export type PaidLine = { label: string; text: string; stale: boolean };

const num = (value: number) => String(value);
/** Codex balance in credit units, exactly as the issuer reported it. */
function codexBalance(paid: PaidUsage): string | null {
  if (paid.unlimited === true) return "unlimited";
  if (paid.balance !== undefined && paid.balance.trim() !== "") return paid.balance;
  return null;
}
/** Short value for the footer item; null means unknown. */
export function paidFooterValue(provider: Provider, paid: PaidUsage | undefined): string | null {
  if (!paid) return null;
  if (provider === "claude")
    return paid.kind !== "extraUsage" || paid.enabled === undefined ? null : paid.enabled ? "On" : "Off";
  if (provider !== "codex" || paid.kind !== "credits") return null;
  if (paid.unlimited === true) return "∞";
  if (paid.balance !== undefined && paid.balance.trim() !== "") return paid.balance;
  if (paid.hasCredits === false) return "0";
  return null;
}

/** Account-detail lines for paid usage and banked resets. Units and estimates are never converted. */
export function paidUsageLines(
  provider: Provider,
  account: Account,
  now = Date.now() / 1000,
): PaidLine[] {
  const lines: PaidLine[] = [];
  const paid = account.paidUsage;
  if (paid && provider === "codex" && paid.kind === "credits") {
    const stale = paidStale(paid, now);
    const prefix = stale ? "Credits (stale): " : "Credits: ";
    const balance = codexBalance(paid);
    let text: string;
    if (balance === "unlimited") text = prefix + "unlimited";
    else if (balance !== null) {
      const zero = paid.hasCredits === false && Number(balance) === 0;
      text = zero ? prefix + `none (${balance} credits)` : `${prefix}${stale ? "~" : ""}${balance} credits`;
    } else if (paid.hasCredits === false) text = prefix + "none";
    else if (paid.hasCredits === true) text = prefix + "available; balance unknown";
    else text = prefix + "unknown";
    const local = paid.approxLocalMessages, cloud = paid.approxCloudMessages;
    if (balance !== null && balance !== "unlimited" && (local !== undefined || cloud !== undefined)) {
      const parts = [
        local !== undefined ? `${num(local)} local` : null,
        cloud !== undefined ? `${num(cloud)} cloud` : null,
      ].filter(Boolean);
      text += ` · estimate: about ${parts.join(" or ")} messages`;
    }
    lines.push({ label: "Credits", text, stale });
  } else if (paid && provider === "claude" && paid.kind === "extraUsage") {
    const stale = paidStale(paid, now);
    const tail = stale ? " (stale)" : "";
    lines.push({
      label: "Extra usage",
      stale,
      text:
        paid.enabled === true
          ? "Extra usage enabled; funds unknown" + tail
          : paid.enabled === false
            ? "Extra usage off" + tail
            : "Extra usage: unknown" + tail,
    });
    if (paid.usedCredits !== undefined)
      lines.push({
        label: "Extra usage amount",
        stale,
        text:
          paid.monthlyLimit !== undefined
            ? `Used ${num(paid.usedCredits)} of ${num(paid.monthlyLimit)} monthly cap (units unknown)`
            : `Used ${num(paid.usedCredits)} (units unknown); monthly cap unknown`,
      });
  }
  if (provider === "codex" && account.resetCreditsAvailable !== undefined)
    lines.push({ label: "Banked resets", text: `Banked resets: ${account.resetCreditsAvailable}`, stale: false });
  return lines;
}

/** "Login check failed" age, only when the CLI reported when it began. */
export function attentionLine(account: Account, now = Date.now() / 1000): { text: string } | null {
  if (account.attentionSince === undefined) return null;
  const age = relativeAge(account.attentionSince, now);
  return age === "unknown" ? null : { text: `Login check failed · first seen ${age}` };
}
