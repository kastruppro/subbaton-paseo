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
  _stale: boolean,
  inferred = false,
) {
  return value === null ? "—" : `${inferred ? "≈" : ""}${Math.round(value)}%`;
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
export function stale(
  window: Window,
  offline = false,
  now = Date.now() / 1000,
) {
  return (
    offline ||
    window.stale ||
    (window.resetsAt !== null && window.resetsAt <= now)
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

export function windowLength(
  provider: Provider,
  window: Window,
): number | null {
  if (
    window.windowSeconds != null &&
    Number.isFinite(window.windowSeconds) &&
    window.windowSeconds > 0
  )
    return window.windowSeconds;
  if (provider === "claude") {
    if (window.id === "five_hour") return 18000;
    if (
      ["seven_day", "seven_day_opus", "seven_day_sonnet"].includes(window.id) ||
      window.id.startsWith("weekly_scoped:")
    )
      return 604800;
  }
  if (provider === "agy") {
    if (window.id.endsWith(":5h")) return 18000;
    if (window.id.endsWith(":weekly")) return 604800;
    const seconds = window.id.match(/:(\d+)s$/);
    if (
      seconds &&
      Number.isFinite(Number(seconds[1])) &&
      Number(seconds[1]) > 0
    )
      return Number(seconds[1]);
  }
  return null;
}
export function paceFraction(
  provider: Provider,
  window: Window,
  now = Date.now() / 1000,
): number | null {
  const length = windowLength(provider, window),
    reset = window.resetsAt;
  if (
    window.inferred ||
    length === null ||
    !Number.isFinite(length) ||
    reset === null ||
    !Number.isFinite(reset) ||
    !Number.isFinite(now)
  )
    return null;
  return Math.max(0, Math.min(1, (now - (reset - length)) / length));
}
function clockTime(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
export function relativeReset(
  value: number | null,
  now = Date.now() / 1000,
): string {
  if (value === null || !Number.isFinite(value) || !Number.isFinite(now))
    return "reset unknown";
  const seconds = value - now;
  if (seconds <= 0) return "reset time passed";
  const date = new Date(value * 1000),
    today = new Date(now * 1000);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(today.getTime()))
    return "reset unknown";
  const days =
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) -
      Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) /
    86400000;
  if (days === 0 || seconds < 21600) {
    const minutes = Math.max(1, Math.ceil(seconds / 60)),
      hours = Math.floor(minutes / 60),
      rest = minutes % 60;
    return (
      "resets in " +
      (hours
        ? `${hours} h${rest ? ` ${String(rest).padStart(2, "0")} min` : ""}`
        : `${minutes} min`)
    );
  }
  if (days === 1) return `resets tomorrow ${clockTime(date)}`;
  if (days < 7)
    return `resets ${date.toLocaleDateString("en-GB", { weekday: "short" })} ${clockTime(date)}`;
  return `resets ${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}
export function relativeAge(
  value: number | null,
  now = Date.now() / 1000,
): string {
  if (
    value === null ||
    value <= 0 ||
    !Number.isFinite(value) ||
    !Number.isFinite(now) ||
    value > now + 60
  )
    return "unknown";
  const minutes = Math.floor(Math.max(0, now - value) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  if (hours < 24) return `${hours} h${rest ? ` ${rest} min` : ""} ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
export function windowPresentation(
  provider: Provider,
  window: Window,
  warning: number,
  danger: number,
  offline = false,
  now = Date.now() / 1000,
) {
  const old = stale(window, offline, now);
  const reset = window.inferred
    ? "reset, presumed fresh"
    : relativeReset(window.resetsAt, now);
  return {
    percent: percentText(window.usedPercent, old, window.inferred),
    clock: old,
    opacity: old ? 0.45 : 1,
    tone: severity(window.usedPercent, false, warning, danger),
    tick: paceFraction(provider, window, now),
    reset,
    accessibility: `${window.label}: ${percentText(window.usedPercent, old, window.inferred)} used${old ? ", stale reading" : ""}. ${reset}. Absolute reset ${timestamp(window.resetsAt)}. Last read ${relativeAge(window.fetchedAt, now)} (${timestamp(window.fetchedAt !== null && window.fetchedAt > 0 ? window.fetchedAt : null)}).`,
  };
}
export function splitWindows(provider: Provider, windows: Window[]) {
  const preferred =
    provider === "claude"
      ? ["five_hour", "seven_day"]
      : provider === "codex"
        ? ["codex:primary_window", "codex:secondary_window"]
        : windows.some((w) => w.id.startsWith("gemini:"))
          ? ["gemini:5h", "gemini:weekly"]
          : ["claude-gpt:5h", "claude-gpt:weekly"];
  let main = preferred.flatMap((id) => windows.filter((w) => w.id === id));
  if (main.length === 0) main = windows.slice(0, 2);
  const ids = new Set(main.map((w) => w.id));
  return { main, extra: windows.filter((w) => !ids.has(w.id)) };
}
export function accountTone(
  account: Account | undefined,
  warning: number,
  danger: number,
) {
  if (!account) return "unknown";
  const tones = [
    account.health === "ok" && account.enabled
      ? "normal"
      : ["needsLogin", "quarantined", "deviceBlocked"].includes(account.health)
        ? "danger"
        : account.health === "attention"
          ? "warning"
          : "unknown",
    ...account.windows.map((w) =>
      severity(w.usedPercent, false, warning, danger),
    ),
  ];
  return tones.includes("danger")
    ? "danger"
    : tones.includes("warning")
      ? "warning"
      : tones.includes("unknown") || account.windows.length === 0
        ? "unknown"
        : "normal";
}
export function compactWindowLabel(provider: Provider, window: Window): string {
  if (provider === "claude")
    return window.id === "five_hour"
      ? "5h"
      : window.id === "seven_day"
        ? "Week"
        : window.id.startsWith("weekly_scoped:")
          ? window.id.slice(14)
          : window.label;
  if (provider === "agy") {
    const group = window.id.startsWith("gemini:")
      ? "Gemini"
      : window.id.startsWith("claude-gpt:")
        ? "C/GPT"
        : "";
    if (group && /:(5h|weekly)$/.test(window.id))
      return `${group} ${window.id.endsWith(":weekly") ? "wk" : "5h"}`;
  }
  if (window.windowSeconds === 604800 || /weekly limit/i.test(window.label))
    return "Week";
  if (window.windowSeconds === 18000 || /5-hour limit/i.test(window.label))
    return "5h";
  return window.label;
}
export function lastRead(account: Account): number | null {
  const times = account.windows.flatMap((w) =>
    w.fetchedAt !== null && w.fetchedAt > 0 ? [w.fetchedAt] : [],
  );
  return times.length ? Math.max(...times) : null;
}

export function popoverBodyHeight(compact: boolean, height: number) {
  const viewport = Number.isFinite(height) && height > 0 ? height : 800;
  return Math.max(
    80,
    Math.min(470, viewport * (compact ? 0.78 : 1) - (compact ? 110 : 160)),
  );
}
