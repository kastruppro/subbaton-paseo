import type { Account, Provider, Window } from "../shared/contracts.js";
import { maxFooterItems } from "../shared/contracts.js";
import { percentText, severity, stale } from "./display.js";
import { windowLabel } from "./popover-model.js";
import { paidFooterValue, paidStale } from "./paid-model.js";

/** Three equal columns like Paseo's CPU / Memory / Disk box; 1-3 items one row, 4-6 two rows. */
export function footerGrid(count: number) {
  const n = Math.max(0, Math.min(maxFooterItems, Math.floor(count) || 0));
  return { count: n, rows: Math.ceil(n / 3), columns: 3 };
}
/** Below this box width one line leaves no room for the long agy group labels. */
export const narrowFooterWidth = 360;

const short: Record<string, string> = { Gemini: "G", "C/GPT": "CG" };
export function footerLabel(provider: Provider, window: Window, narrow: boolean) {
  const label = windowLabel(provider, window);
  if (!narrow || provider !== "agy") return label;
  const [group, ...rest] = label.split(" ");
  return short[group!] && rest.length ? `${short[group!]} ${rest.join(" ")}` : label;
}

export type FooterCell = {
  kind: "value" | "stale" | "unknown" | "blocked";
  label: string;
  percent: string;
  tone: "normal" | "warning" | "danger" | "unknown";
  fill: number;
  clock: boolean;
  /** False for the Credits item, which shows a value without a meter. */
  meter: boolean;
};
const blockedHealth = ["needsLogin", "quarantined", "deviceBlocked"];
export function footerCell(
  item: {
    provider: Provider;
    windowId: string;
    account: Account | null;
    window: Window | null;
  },
  opts: {
    warning: number;
    danger: number;
    offline: boolean;
    narrow: boolean;
    now?: number;
  },
): FooterCell {
  const now = opts.now ?? Date.now() / 1000,
    { window, account } = item;
  if (item.windowId === paidWindowId) return paidCell(item.provider, account, opts.narrow, now);
  const label = window
    ? footerLabel(item.provider, window, opts.narrow)
    : footerLabel(
        item.provider,
        {
          id: item.windowId,
          label: item.windowId,
          usedPercent: null,
          resetsAt: null,
          stale: false,
          inferred: false,
          fetchedAt: null,
        },
        opts.narrow,
      );
  const value = window?.usedPercent ?? null;
  const passed =
    !!window &&
    !window.inferred &&
    window.resetsAt !== null &&
    window.resetsAt <= now;
  if (account && blockedHealth.includes(account.health))
    return { kind: "blocked", label, percent: "—", tone: "danger", fill: 0, clock: false, meter: true };
  if (!window || value === null || passed)
    return { kind: "unknown", label, percent: "—", tone: "unknown", fill: 0, clock: false, meter: true };
  if (value >= 100 && !window.inferred)
    return { kind: "blocked", label, percent: "100%", tone: "danger", fill: 100, clock: false, meter: true };
  const old = stale(window, opts.offline, now);
  const text = percentText(value, old, window.inferred);
  return {
    kind: old ? "stale" : "value",
    label,
    percent: old ? `~${text}` : text,
    tone: severity(value, false, opts.warning, opts.danger) as FooterCell["tone"],
    fill: Math.max(0, Math.min(100, value)),
    clock: old,
    meter: true,
  };
}
export function footerSummary(input: {
  settingsReady: boolean;
  itemCount: number;
  offline: boolean;
}): "loading" | "unavailable" | "none" | "grid" {
  if (!input.settingsReady) return "loading";
  if (input.offline) return "unavailable";
  return input.itemCount === 0 ? "none" : "grid";
}

/** Reserved window ID for the Credits (Codex) / Extra usage (Claude) footer item. */
export const paidWindowId = "paid";
const paidLabels: Record<string, [string, string]> = { codex: ["Credits", "Cr"], claude: ["Extra", "Ex"] };
function paidCell(provider: Provider, account: Account | null, narrow: boolean, now: number): FooterCell {
  const label = (paidLabels[provider] ?? ["Paid", "Paid"])[narrow ? 1 : 0];
  const value = paidFooterValue(provider, account?.paidUsage);
  if (value === null || !account?.paidUsage)
    return { kind: "unknown", label, percent: "—", tone: "unknown", fill: 0, clock: false, meter: false };
  const old = paidStale(account.paidUsage, now);
  return {
    kind: old ? "stale" : "value",
    label,
    percent: old ? `~${value}` : value,
    tone: "normal",
    fill: 0,
    clock: old,
    meter: false,
  };
}
