import type {
  Status,
  DisplaySettings,
  Provider,
  Window,
  Account,
} from "../shared/contracts.js";
export const providerLabel: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
  agy: "agy",
};
export const providerIcon: Record<Provider, string> = {
  claude: "Bot",
  codex: "Terminal",
  agy: "Sparkles",
};
export function percentText(value: number | null, stale: boolean) {
  return value === null ? "—" : `${stale ? "~" : ""}${Math.round(value)}%`;
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
