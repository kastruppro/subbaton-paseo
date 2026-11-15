import type {
  Account,
  Provider,
  ProviderStatus,
  Window,
} from "../shared/contracts.js";
import type { StrategyPreview } from "../shared/contracts.js";
import type { Handoff } from "../shared/handoff.js";
import { activePhases } from "../shared/handoff.js";
import { accountTone, lastRead, providerLabel, severity, shortWarning, windowPresentation } from "./display.js";
import { attentionLine, paidUsageLines, type PaidLine } from "./paid-model.js";

const groupName = (id: string) =>
  id.startsWith("gemini:") ? "Gemini" : id.startsWith("claude-gpt:") ? "C/GPT" : "";
/** The Gemini model-quota row: its window length is unknown, so it has no duration, pace tick or reset time. */
export const isModelQuota = (w: Pick<Window, "id" | "quotaSource" | "window">) =>
  w.id === "gemini:unknown" || (w.quotaSource === "models" && w.window === "unknown");
export const windowLongLabel = (provider: Provider, w: Window) =>
  provider === "agy" && isModelQuota(w) ? "Gemini (model quota)" : windowLabel(provider, w);
/** Shared wording: 5h / 7d rolling windows, model or group name plus duration. */
export function windowLabel(provider: Provider, window: Window): string {
  const id = window.id;
  if (provider === "agy" && isModelQuota(window)) return "Gemini";
  if (provider === "claude") {
    if (id === "five_hour") return "5h";
    if (id === "seven_day") return "7d";
    if (id === "seven_day_opus") return "Opus 7d";
    if (id === "seven_day_sonnet") return "Sonnet 7d";
    if (id.startsWith("weekly_scoped:")) return `${id.slice(14)} 7d`;
  }
  const duration =
    id.endsWith(":5h") || window.windowSeconds === 18000
      ? "5h"
      : id.endsWith(":weekly") || window.windowSeconds === 604800
        ? "7d"
        : id === "codex:primary_window"
          ? "5h"
          : id === "codex:secondary_window"
            ? "7d"
            : null;
  if (provider === "agy") {
    const group = groupName(id);
    if (group && duration) return `${group} ${duration}`;
  }
  return duration ?? window.label;
}

/** Windows shown by the collapsed row: 5h + 7d (agy: its two 5h groups). */
export function miniWindows(provider: Provider, windows: Window[]): Window[] {
  const ids: string[] =
    provider === "claude"
      ? ["five_hour", "seven_day"]
      : provider === "codex"
        ? ["codex:primary_window", "codex:secondary_window"]
        : ["gemini:5h", "claude-gpt:5h"];
  // Gemini slot: a real Gemini window wins, otherwise the model-quota row.
  if (provider === "agy" && !windows.some((w) => w.id === "gemini:5h")) {
    const model = windows.find(isModelQuota);
    if (model) ids[0] = model.id;
  }
  const picked = ids.flatMap((id) => windows.filter((w) => w.id === id));
  return picked.length ? picked : windows.slice(0, 2);
}

export type Tone = "normal" | "warning" | "danger" | "unknown";
const blocked = ["quarantined", "deviceBlocked", "needsLogin"];
export function canSwitch(account: Account) {
  return !account.active && account.enabled && !blocked.includes(account.health);
}
export function accountBadge(
  account: Account,
  warning: number,
  danger: number,
  now = Date.now() / 1000,
): { text: string; tone: Tone } | undefined {
  const live = account.windows.filter(
    (w) => w.inferred || w.resetsAt === null || w.resetsAt > now,
  );
  const worst = Math.max(-1, ...live.map((w) => w.usedPercent ?? -1));
  if (account.health === "needsLogin") return { text: "Needs login", tone: "danger" };
  if (account.health === "quarantined") return { text: "Quarantined", tone: "danger" };
  if (account.health === "deviceBlocked") return { text: "Device blocked", tone: "danger" };
  if (!account.enabled) return { text: "Disabled", tone: "unknown" };
  if (account.health === "attention") return { text: "Login check failed", tone: "warning" };
  if (account.usageStatus === "needs-renewal" || account.usageStatus === "needsRenewal")
    return { text: "Needs renewal", tone: "warning" };
  if (worst >= 100) return { text: "Exhausted", tone: "danger" };
  if (account.active) return { text: "Active", tone: "normal" };
  if (worst >= warning && severity(worst, false, warning, danger) !== "normal")
    return { text: "Near limit", tone: "warning" };
  return undefined;
}
export function rowGlyph(
  account: Account | undefined,
  warning: number,
  danger: number,
): "ok" | "warn" | "crit" | "mute" {
  if (!account) return "mute";
  const tone = accountTone(account, warning, danger);
  return tone === "normal" ? "ok" : tone === "warning" ? "warn" : tone === "danger" ? "crit" : "mute";
}
export function otherAccountSummary(
  provider: Provider,
  account: Account,
  opts: { offline?: boolean; now?: number } = {},
): string {
  const now = opts.now ?? Date.now() / 1000;
  return miniWindows(provider, account.windows)
    .filter((w) => w.usedPercent !== null)
    .map((w) => {
      const view = windowPresentation(provider, w, 100, 100, opts.offline ?? false, now);
      const percent =
        view.clock && view.percent !== "—" && !w.inferred ? `~${view.percent}` : view.percent;
      return `${windowLabel(provider, w)} ${percent}`;
    })
    .join(" · ");
}
export const switchChoices = (provider: Provider): ("now" | "idle")[] =>
  provider === "claude" ? ["now"] : ["now", "idle"];
export function idleExplanation(provider: "codex" | "agy", restartDaemon: boolean) {
  return provider === "agy"
    ? "Waits until no Paseo agy agent is working, then closes them, switches and reopens them."
    : restartDaemon
      ? "Waits until no Paseo Codex agent is working, then switches and restarts the daemon."
      : "Switches now, reloads the Codex agents that are not working at once and the others as soon as they are idle.";
}

export type RowLine = {
  kind: "info" | "warning" | "danger" | "loading" | "error";
  text: string;
  /** Colour of the line; follows `kind` unless a loading or error line is plain. */
  tone: "muted" | "warning" | "danger";
  action?: "cancel" | "details" | "retry";
  disableSwitching?: boolean;
};
const active = (activePhases as readonly string[]);
export function handoffRow(h: Handoff | null | undefined): RowLine | null {
  if (!h) return null;
  const alias = h.targetAlias ?? "saved account";
  // A renewal-only handoff (no known target yet) renews candidates; one with a target is a plain switch.
  const renewing = h.provider === "agy" && h.trigger === "automaticSwitch" && h.target === null;
  if (h.phase === "waiting")
    return {
      kind: "warning", tone: "warning",
      text: `${renewing ? "Renewing agy accounts" : `Switching to ${alias}`} when idle · ${h.waitingFor} agent${h.waitingFor === 1 ? "" : "s"} working`,
      action: "cancel",
    };
  if (h.phase === "switching" && renewing)
    return { kind: "warning", tone: "warning", text: "Renewing agy accounts and switching…" };
  if (active.includes(h.phase))
    return {
      kind: "warning", tone: "warning",
      text: `${h.phase === "switching" ? "Switching" : "Reopening agents"} (${alias})`,
      action: h.phase === "reopening" ? "cancel" : undefined,
    };
  if (h.phase === "uncertain")
    return {
      kind: "danger", tone: "danger",
      text: `Switch to ${alias} uncertain – check the ${providerLabel[h.provider]} login`,
      action: "details",
    };
  if (h.phase === "failed" || h.phase === "expired")
    return {
      kind: "danger", tone: "danger",
      text: `Switch to ${alias} ${h.phase === "expired" ? "expired" : "failed"}`,
      action: "details",
    };
  return null;
}
export function providerLine(input: {
  queryError: string | null;
  pending: boolean;
  hasData: boolean;
  provider: Pick<ProviderStatus, "cacheStatus" | "accounts"> | undefined;
}): RowLine | null {
  if (input.queryError !== null)
    return { kind: "error", tone: "danger", text: `Status unreadable: ${input.queryError}`, action: "retry", disableSwitching: true };
  if (!input.hasData)
    return input.pending
      ? { kind: "loading", tone: "muted", text: "Loading cached status…", disableSwitching: true }
      : { kind: "error", tone: "danger", text: "Status unreadable", action: "retry", disableSwitching: true };
  const p = input.provider;
  if (!p || p.cacheStatus === "missing")
    return { kind: "error", tone: "danger", text: "No usage read yet. Refresh to read it.", disableSwitching: true };
  if (p.cacheStatus !== "available")
    return { kind: "error", tone: "danger", text: "Usage unavailable. Refresh to try again.", action: "retry", disableSwitching: true };
  if (p.accounts.length === 0) return { kind: "info", tone: "muted", text: "No accounts yet" };
  return null;
}
export function autoLines(
  provider: Provider,
  status: Pick<ProviderStatus, "auto" | "daemonRestartPending"> | undefined,
): RowLine[] {
  const lines: RowLine[] = [];
  const auto = status?.auto;
  if (auto?.paused)
    lines.push({
      kind: "warning", tone: "warning",
      text: `Automatic switching paused${auto.pauseReason ? ` (${auto.pauseReason})` : ""}`,
    });
  if (provider === "codex" && status?.daemonRestartPending === true)
    lines.push({ kind: "warning", tone: "warning", text: "Restart pending, waits for idle" });
  return lines;
}

/** "Switch to best account" appears once per expanded provider that has another account. */
export const showBestSwitch = (_provider: Provider, otherAccounts: number) =>
  otherAccounts > 0;
export function bestPreviewLine(
  r: Pick<StrategyPreview, "outcome" | "message"> & { alias?: string },
): RowLine | null {
  if (r.outcome === "target") return null;
  if (r.outcome === "unchanged")
    return {
      kind: "info",
      tone: "muted",
      text: r.alias ? `${r.alias} is already the best account.` : "The active account is already the best.",
    };
  if (r.outcome === "none")
    return { kind: "info", tone: "muted", text: "No account is eligible right now." };
  return { kind: "error", tone: "danger", text: r.message };
}

/** What an expanded provider row shows; saved accounts never depend on an active account. */
export function expandedSections(
  provider: Provider,
  accounts: Account[],
  switchingDisabled: boolean,
) {
  const hasActive = accounts.some((a) => a.active);
  const others = switchingDisabled ? [] : accounts.filter((a) => !a.active);
  return {
    activeDetails: hasActive && !switchingDisabled,
    noActiveNote:
      !hasActive && accounts.length > 0 && !switchingDisabled
        ? "No active account. Choose one to switch to."
        : null,
    others,
    best: showBestSwitch(provider, others.length),
  };
}

/** One neutral grey line (never a warning) when an agy account has usage data but no Gemini window. */
export function geminiNotice(provider: Provider, account: Account): { text: string; tone: "muted" } | null {
  if (provider !== "agy") return null;
  // Without any usage data the row's own state text (needs login, not read yet, ...) says why.
  if (account.windows.length === 0) return null;
  const has = account.windows.some((w) => w.id.startsWith("gemini:") || isModelQuota(w));
  return has ? null : { text: "Gemini: not available", tone: "muted" };
}

/** How the login of an account ends; the wording is shared by the active account and every other account. */
export function loginText(provider: Provider, account: Account): string {
  return account.loginExpiresAt != null
    ? `login valid until ${new Date(account.loginExpiresAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
    : provider === "codex"
      ? "login has no fixed end date"
      : provider === "agy"
        ? "login renewed by agy"
        : "login expiry unknown";
}
export interface AccountDetailModel {
  identity: string;
  badge: ReturnType<typeof accountBadge>;
  windows: Window[];
  usageUnknown: boolean;
  gemini: string | null;
  warning: string | null;
  readAt: number | null;
  loginText: string;
  attention: string | null;
  paid: PaidLine[];
}
/** Everything the detail block shows for one account. The active account and every expanded other account use it. */
export function accountDetail(
  provider: Provider,
  account: Account,
  opts: { warning: number; danger: number; offline: boolean; now?: number },
): AccountDetailModel {
  const now = opts.now ?? Date.now() / 1000;
  return {
    identity: [account.email ?? "Email unknown", account.plan ?? "Plan unknown"].join(" · "),
    badge: accountBadge(account, opts.warning, opts.danger, now),
    windows: account.windows,
    usageUnknown: account.windows.length === 0,
    gemini: geminiNotice(provider, account)?.text ?? null,
    warning: shortWarning(provider, account.summaryStatus, account.warnings),
    readAt: lastRead(account),
    loginText: loginText(provider, account),
    attention: attentionLine(account, now)?.text ?? null,
    paid: paidUsageLines(provider, account, now),
  };
}
/** Several other accounts can be open at once; each id toggles on its own. */
export function toggleOpenAccount(open: readonly string[], id: string): string[] {
  return open.includes(id) ? open.filter((value) => value !== id) : [...open, id];
}
/** A status refresh keeps the accounts that are still there open and forgets the ones that disappeared. */
export function pruneOpenAccounts(open: readonly string[], accounts: readonly Account[]): string[] {
  const known = new Set(accounts.map((a) => a.id));
  return open.filter((id) => known.has(id));
}
