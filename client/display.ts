import type {
  Status,
  DisplaySettings,
  Provider,
  Window,
  Account,
} from "../shared/contracts.js";
export const providerLabel: Record<Provider | "unknown", string> = {
  claude: "Claude",
  codex: "Codex",
  agy: "agy",
  unknown: "Unknown provider",
};
export const providerIcon: Record<Provider | "unknown", string> = {
  claude: "Bot",
  codex: "Terminal",
  agy: "Sparkles",
  unknown: "HelpCircle",
};
export function percentText(
  value: number | null,
  stale: boolean,
  inferred = false,
) {
  return value === null
    ? "—"
    : `${stale ? "~" : ""}${inferred ? "≈" : ""}${Math.round(value)}%`;
}
export function severity(
  value: number | null,
  stale: boolean,
  warning: number,
  danger: number,
) {
  return value === null || stale
    ? "unknown"
    : value >= danger
      ? "danger"
      : value >= warning
        ? "warning"
        : "normal";
}
export function chooseItems(
  status: Status | null,
  items: DisplaySettings["items"],
): {
  provider: Provider;
  windowId: string;
  window: Window | null;
  account: Account | null;
}[] {
  return items.map((item) => {
    const account =
      status?.providers
        .find((p) => p.provider === item.provider)
        ?.accounts.find((a) => a.active) ?? null;
    return {
      ...item,
      account,
      window: account?.windows.find((w) => w.id === item.windowId) ?? null,
    };
  });
}
export function timestamp(value: number | null) {
  if (value === null) return "unknown";
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "unknown";
}
export function stale(window: Window, offline = false) {
  return (
    offline ||
    window.stale ||
    (window.resetsAt !== null && window.resetsAt <= Date.now() / 1000)
  );
}

export function windowTitle(id: string, label?: string) {
  if (label) return label;
  const known: Record<string, string> = {
    five_hour: "5-hour limit",
    seven_day: "Weekly limit",
    seven_day_opus: "Opus",
    seven_day_sonnet: "Sonnet",
    "codex:primary_window": "Primary window",
    "codex:secondary_window": "Secondary window",
  };
  return (
    known[id] ??
    (id.startsWith("weekly_scoped:") ? id.slice(14) : "Saved quota window")
  );
}

export function stripLayout(width: number, count: number) {
  const available = Math.max(0, Number.isFinite(width) ? width : 0),
    total = Math.max(0, Math.min(24, Math.floor(count)));
  for (const [unit, labels, meters] of [
    [160, true, true],
    [120, false, true],
    [96, false, false],
  ] as const) {
    if (total * unit <= available)
      return {
        count: total,
        hidden: 0,
        labels,
        meters,
        usedWidth: total * unit,
      };
  }
  const shown = Math.min(total, Math.max(0, Math.floor((available - 24) / 96)));
  return {
    count: shown,
    hidden: total - shown,
    labels: false,
    meters: false,
    usedWidth: Math.min(available, shown * 96 + 24),
  };
}
export function shortWindowTitle(id: string, label?: string) {
  if (id === "five_hour" || label === "5-hour limit") return "5h";
  if (id === "seven_day" || label === "Weekly limit") return "7d";
  if (id === "codex:primary_window") return "P";
  if (id === "codex:secondary_window") return "S";
  return windowTitle(id, label).slice(0, 4);
}
