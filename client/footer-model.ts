import type { Account, Provider, Window } from "../shared/contracts.js";
import { maxFooterItems } from "../shared/contracts.js";
import { percentText, providerLabel, severity, stale } from "./display.js";
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
  /** Text colour token: the host foreground (as in Paseo's CPU box), status colour only near or at the limit. */
  textTone: "text" | "warning" | "danger";
  /** Full spoken name of the item without the provider, e.g. "Claude and GPT 5 hours" or "credits". */
  spoken: string;
};
const expand = (label: string) =>
  label.replace(/C\/GPT/g, "Claude and GPT").replace(/\b(\d+)h\b/g, "$1 hours").replace(/\b(\d+)d\b/g, "$1 days");
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
  const spoken = expand(
    window
      ? windowLabel(item.provider, window)
      : windowLabel(item.provider, { id: item.windowId, label: item.windowId, usedPercent: null, resetsAt: null, stale: false, inferred: false, fetchedAt: null }),
  );
  const value = window?.usedPercent ?? null;
  const passed =
    !!window &&
    !window.inferred &&
    window.resetsAt !== null &&
    window.resetsAt <= now;
  if (account && blockedHealth.includes(account.health))
    return { kind: "blocked", label, percent: "—", tone: "danger", fill: 0, clock: false, meter: true, textTone: "danger", spoken };
  if (!window || value === null || passed)
    return { kind: "unknown", label, percent: "—", tone: "unknown", fill: 0, clock: false, meter: true, textTone: "text", spoken };
  if (value >= 100 && !window.inferred)
    return { kind: "blocked", label, percent: "100%", tone: "danger", fill: 100, clock: false, meter: true, textTone: "danger", spoken };
  const old = stale(window, opts.offline, now);
  const text = percentText(value, old, window.inferred);
  const level = severity(value, false, opts.warning, opts.danger);
  return {
    kind: old ? "stale" : "value",
    label,
    percent: old ? `~${text}` : text,
    tone: level as FooterCell["tone"],
    fill: Math.max(0, Math.min(100, value)),
    clock: old,
    meter: true,
    spoken,
    textTone: old ? "text" : level === "danger" ? "danger" : level === "warning" ? "warning" : "text",
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
  const spoken = provider === "claude" ? "extra usage" : "credits";
  const value = paidFooterValue(provider, account?.paidUsage);
  if (value === null || !account?.paidUsage)
    return { kind: "unknown", label, percent: "—", tone: "unknown", fill: 0, clock: false, meter: false, textTone: "text", spoken };
  const old = paidStale(account.paidUsage, now);
  return {
    kind: old ? "stale" : "value",
    label,
    percent: old ? `~${value}` : value,
    tone: "normal",
    fill: 0,
    clock: old,
    meter: false,
    textTone: "text",
    spoken,
  };
}

/** One spoken label per cell: names the item, the value and any state (stale, unknown, near limit, ...). */
export function footerSpeech(provider: Provider, cell: FooterCell): string {
  const subject = `${providerLabel[provider]} ${cell.spoken}`;
  if (cell.kind === "unknown") return `${subject}, unknown`;
  if (cell.kind === "blocked")
    return cell.percent === "100%" ? `${subject}, 100 percent used, exhausted` : `${subject}, unavailable`;
  const stale = cell.kind === "stale";
  if (!cell.meter) {
    const value = (stale ? cell.percent.replace(/^~/, "") : cell.percent).replace("∞", "unlimited");
    return stale ? `${subject}, about ${value}, stale` : `${subject}, ${value}`;
  }
  const estimated = cell.percent.startsWith("≈");
  const number = cell.percent.replace(/^[~≈]/, "").replace("%", "");
  if (stale) return `${subject}, about ${number} percent used, stale`;
  if (estimated) return `${subject}, about ${number} percent used, estimated`;
  return `${subject}, ${number} percent used${cell.textTone === "warning" ? ", near limit" : ""}`;
}
