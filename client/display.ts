import type { PluginTheme } from "@getpaseo/plugin";
import { footerHoverSurface } from "./contrast.js";
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
/**
 * A saved or default agy "gemini:<duration>" footer item with no window of its own shows the account's
 * Gemini model-quota window (label "Gemini", no duration); a real window with that ID always wins.
 */
function geminiFallback(provider: Provider, windowId: string, account: Account | null): Window | null {
  if (provider !== "agy" || !account || !/^gemini:(?!unknown$)/.test(windowId)) return null;
  return account.windows.find((w) => w.id === "gemini:unknown" || (w.quotaSource === "models" && w.window === "unknown")) ?? null;
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
      window:
        account?.windows.find((w) => w.id === item.windowId) ??
        geminiFallback(item.provider, item.windowId, account),
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
    "gemini:unknown": "Gemini (model quota)",
  };
  return (
    known[id] ??
    (id.startsWith("weekly_scoped:") ? id.slice(14) : "Saved quota window")
  );
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
  const passed =
    !window.inferred && window.resetsAt !== null && window.resetsAt <= now;
  const old = stale(window, offline, now);
  const reset = window.inferred
    ? "reset, presumed fresh"
    : passed
      ? "reset passed, refresh to update"
      : relativeReset(window.resetsAt, now);
  return {
    percent: passed
      ? "—"
      : percentText(window.usedPercent, old, window.inferred),
    fillPercent: passed ? 0 : (window.usedPercent ?? 0),
    clock: old,
    opacity: old ? 0.45 : 1,
    tone: severity(window.usedPercent, false, warning, danger),
    tick: passed ? null : paceFraction(provider, window, now),
    reset,
    accessibility: `${window.label}: ${passed ? "unknown after reset" : percentText(window.usedPercent, old, window.inferred)} used${old ? ", stale reading" : ""}. ${reset}. Absolute reset ${timestamp(window.resetsAt)}. Last read ${relativeAge(window.fetchedAt, now)} (${timestamp(window.fetchedAt !== null && window.fetchedAt > 0 ? window.fetchedAt : null)}).`,
  };
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

export function themePalette(theme: PluginTheme) {
  const c = theme.colors;
  return {
    sidebar: c.surface0,
    pop: c.surface1,
    row: c.surface1,
    hover: c.surface2,
    footerHover: footerHoverSurface(c),
    line: c.border,
    text: c.foreground,
    muted: c.foregroundMuted,
    faint: c.foregroundMuted,
    ok: c.statusSuccess,
    warning: c.statusWarning,
    danger: c.statusDanger,
    track: c.surface2,
    trackEdge: c.border,
    fill: c.foregroundMuted,
    accent: c.accent,
    onAccent: c.accentForeground,
    focus: c.accent,
    tick: c.foreground,
  };
}
export function keyboardFocus(target: unknown): boolean {
  try {
    return !!(target as { matches?: (selector: string) => boolean })?.matches?.(
      ":focus-visible",
    );
  } catch {
    return false;
  }
}
export function actionNotice(
  result: import("../shared/contracts.js").ActionResult,
): string | null {
  if (result.outcome !== "error" && result.outcome !== "uncertain") return null;
  if (result.outcome === "uncertain")
    return (
      result.message.split(/[\r\n]/)[0].slice(0, 110) +
      " Run SubBaton recovery before retrying."
    );
  return result.message.split(/[\r\n]/)[0].slice(0, 180);
}
export function shortWarning(
  provider: Provider,
  status: string | null | undefined,
  warnings: string[] = [],
): string | null {
  // A partial agy summary is no warning: the Gemini row (or a neutral "Gemini: not available" line) says it.
  if (provider === "agy" && status === "partial-groups") return null;
  if (status) return "Quota summary unavailable; some readings are stale";
  return warnings.length ? "Account needs attention; expand for details" : null;
}

export function providerNotices(
  previous: Partial<Record<Provider, string>>,
  rows: {
    provider: Provider | null;
    result: import("../shared/contracts.js").ActionResult;
  }[],
  requested: Provider,
) {
  const next = { ...previous };
  for (const row of rows)
    next[row.provider ?? requested] = actionNotice(row.result) ?? undefined;
  return next;
}
