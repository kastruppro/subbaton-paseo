import type {
  AutoPlan,
  Leaf,
  SettingsAccount,
  SettingsChange,
  SettingsField,
  SettingsSection,
  SubBatonEvent,
} from "../shared/settings.js";
import { identifierPattern } from "../shared/settings.js";

// Pure model for the CLI-driven settings screen. Every title, description, bound, enum and
// knownKeys suggestion comes from the CLI field metadata; nothing here encodes SubBaton policy.

export type Control =
  | { kind: "switch" }
  | {
      kind: "number";
      integer: boolean;
      minimum?: number;
      maximum?: number;
      ranges?: [number, number][];
    }
  | {
      kind: "select";
      options: { value: string; label: string; description: string }[];
    }
  | { kind: "dictionary"; keys: string[]; child: SettingsField | null }
  | { kind: "order" }
  | { kind: "unsupported" };

export interface FieldView {
  /** Provider-relative path segments used for changes (account fields include the account ID). */
  path: string[];
  key: string;
  field: SettingsField;
  control: Control;
  value: Leaf | undefined;
  effective: Leaf | undefined;
  pending: boolean;
  /** Nullable field currently inheriting (null). */
  inherits: boolean;
  /** The stored value changed elsewhere after this draft started (shown after a conflict). */
  changedElsewhere: boolean;
  runtime: "Active now" | "Stored only" | "Runtime unknown";
}

export type Draft = Record<string, { path: string[]; value: Leaf }>;
export const draftKey = (path: string[]) => path.join("/");

const isChild = (field: SettingsField) => /<(window|model)>/.test(field.path);
const runtimeLabel = (runtime: SettingsField["runtime"]): FieldView["runtime"] =>
  runtime === "active" ? "Active now" : runtime === "persistedOnly" ? "Stored only" : "Runtime unknown";

export function controlFor(section: SettingsSection, field: SettingsField, value: Leaf | undefined): Control {
  switch (field.type) {
    case "boolean":
      return { kind: "switch" };
    case "number":
    case "integer":
      return {
        kind: "number",
        integer: field.type === "integer",
        ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
        ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
        ...(field.allowedRanges ? { ranges: field.allowedRanges } : {}),
      };
    case "string":
      return field.enum
        ? {
            kind: "select",
            options: field.enum.map((v) => ({
              value: v,
              label: v,
              description: field.enumDescriptions?.[v] ?? "",
            })),
          }
        : { kind: "unsupported" };
    case "object": {
      const current = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
      const keys = Array.from(new Set([...(field.knownKeys ?? []), ...current])).sort((a, b) => a.localeCompare(b));
      const child =
        section.fields.find((f) => isChild(f) && f.path.startsWith(field.path + ".<")) ?? null;
      return { kind: "dictionary", keys, child };
    }
    case "array":
      return field.path === "order" ? { kind: "order" } : { kind: "unsupported" };
    default:
      return { kind: "unsupported" };
  }
}

function view(
  section: SettingsSection,
  field: SettingsField,
  path: string[],
  value: Leaf | undefined,
  effective: Leaf | undefined,
  draft: Draft,
  changed: ReadonlySet<string> = new Set(),
): FieldView {
  const key = draftKey(path);
  const pending = Object.hasOwn(draft, key);
  const shown = pending ? draft[key]!.value : value;
  return {
    path,
    key,
    field,
    control: controlFor(section, field, shown),
    value: shown,
    effective,
    pending,
    inherits: field.nullable && shown === null,
    changedElsewhere: changed.has(key),
    runtime: runtimeLabel(field.runtime),
  };
}

export const groupOrder = [
  "Automatic switching",
  "Thresholds",
  "Weekly reset priority",
  "Inactive polling",
  "Notifications",
  "Other settings",
] as const;
export type GroupTitle = (typeof groupOrder)[number];
export function groupFor(path: string): GroupTitle {
  if (["autoEnabled", "strategy", "cooldownMinutes", "improvementMargin"].includes(path)) return "Automatic switching";
  if (path.startsWith("thresholds.")) return "Thresholds";
  if (path.startsWith("weeklyResetPriority.")) return "Weekly reset priority";
  if (path === "inactiveIntervalHours") return "Inactive polling";
  if (path.startsWith("notifications.")) return "Notifications";
  return "Other settings";
}

/** Provider-level fields grouped for display; account fields and order are handled separately. */
export function providerGroups(section: SettingsSection, draft: Draft, changed?: ReadonlySet<string>) {
  const groups = new Map<GroupTitle, FieldView[]>();
  for (const field of section.fields) {
    if (isChild(field) || field.path.startsWith("accounts.") || field.path === "order") continue;
    const path = field.path.split(".");
    const item = view(section, field, path, section.values[field.path], section.effective[field.path], draft, changed);
    const title = groupFor(field.path);
    groups.set(title, [...(groups.get(title) ?? []), item]);
  }
  return groupOrder.filter((t) => groups.has(t)).map((title) => ({ title, fields: groups.get(title)! }));
}

export function accountFields(section: SettingsSection, account: SettingsAccount, draft: Draft, changed?: ReadonlySet<string>) {
  const prefix = "accounts.<account>.";
  return section.fields
    .filter((f) => f.path.startsWith(prefix) && !isChild(f))
    .map((field) => {
      const sub = field.path.slice(prefix.length);
      return view(section, field, ["accounts", account.id, ...sub.split(".")], account.values[sub], account.effective[sub], draft, changed);
    });
}

export function orderView(section: SettingsSection, draft: Draft, changed?: ReadonlySet<string>) {
  const field = section.fields.find((f) => f.path === "order");
  if (!field) return null;
  const item = view(section, field, ["order"], section.values.order, undefined, draft, changed);
  const ids = Array.isArray(item.value) ? item.value : section.accounts.map((a) => a.id);
  const accounts = ids.flatMap((id) => section.accounts.filter((a) => a.id === id));
  return { ...item, accounts };
}

export function move(ids: string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

const describeBounds = (field: SettingsField) => {
  const unit = field.unit && field.unit !== "none" ? ` (${field.unit})` : "";
  if (field.allowedRanges?.length)
    return field.allowedRanges.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo} to ${hi}`)).join(" or ") + unit;
  if (field.minimum !== undefined && field.maximum !== undefined) return `${field.minimum} to ${field.maximum}${unit}`;
  if (field.minimum !== undefined) return `at least ${field.minimum}${unit}`;
  if (field.maximum !== undefined) return `at most ${field.maximum}${unit}`;
  return `a number${unit}`;
};
export function rangeHint(field: SettingsField) {
  return (field.type === "integer" ? "Whole number, " : "") + describeBounds(field) + (field.nullable ? ". Empty inherits." : ".");
}

/** Parses typed text against the CLI bounds. Empty means inherit for nullable fields. */
export function parseNumber(text: string, field: SettingsField): { value: number | null } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return field.nullable ? { value: null } : { error: `Enter ${describeBounds(field)}.` };
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { error: `Enter ${describeBounds(field)}.` };
  const value = Number(trimmed);
  const ok =
    Number.isFinite(value) &&
    (field.minimum === undefined || value >= field.minimum) &&
    (field.maximum === undefined || value <= field.maximum) &&
    (field.type !== "integer" || Number.isInteger(value)) &&
    (!field.allowedRanges || field.allowedRanges.some(([lo, hi]) => value >= lo && value <= hi));
  return ok ? { value } : { error: `Enter ${field.type === "integer" ? "a whole number, " : ""}${describeBounds(field)}.` };
}

export function validKey(key: string) {
  return identifierPattern.test(key);
}

export function formatLeaf(value: Leaf | undefined, field?: SettingsField): string {
  if (value === undefined) return "unavailable";
  if (value === null) return "inherit";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return field?.unit && !["none", "percent used"].includes(field.unit) ? `${value} ${field.unit.split(";")[0]}` : field?.unit === "percent used" ? `${value}%` : String(value);
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.join(", ") : `${Object.values(value).filter((v) => v !== null).length} set`;
}

export function setDraft(draft: Draft, section: SettingsSection, path: string[], value: Leaf, original: Leaf | undefined): Draft {
  const key = draftKey(path);
  const next = { ...draft };
  if (JSON.stringify(value) === JSON.stringify(original)) delete next[key];
  else next[key] = { path, value };
  // A whole-dictionary write replaces individual child writes and vice versa.
  for (const other of Object.keys(next))
    if (other !== key && (other.startsWith(key + "/") || key.startsWith(other + "/"))) delete next[other];
  void section;
  return next;
}

/** Original stored value for a provider-relative path (used to drop no-op draft edits). */
export function storedValue(section: SettingsSection, path: string[]): Leaf | undefined {
  if (path[0] === "accounts") {
    const account = section.accounts.find((a) => a.id === path[1]);
    const sub = path.slice(2);
    if (!account) return undefined;
    const direct = account.values[sub.join(".")];
    if (direct !== undefined || sub.length < 2) return direct;
    const parent = account.values[sub.slice(0, -1).join(".")];
    return parent && typeof parent === "object" && !Array.isArray(parent) ? (parent[sub.at(-1)!] ?? null) : undefined;
  }
  const direct = section.values[path.join(".")];
  if (direct !== undefined || path.length < 2) return direct;
  const parent = section.values[path.slice(0, -1).join(".")];
  return parent && typeof parent === "object" && !Array.isArray(parent) ? (parent[path.at(-1)!] ?? null) : undefined;
}

export function draftChanges(draft: Draft): SettingsChange[] {
  return Object.values(draft).map(({ path, value }) => ({ path, value }));
}

export const humanize = (code: string) =>
  code
    .replace(/[-_]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();

export function accountBadges(account: SettingsAccount) {
  return [
    account.quarantined ? "Quarantined" : null,
    account.deviceBlocked ? "Device blocked" : null,
    account.needsLogin ? "Needs login" : null,
  ].filter((v): v is string => v !== null);
}

/** Account IDs → aliases as the CLI reports them in settings; events carry IDs only. */
export function aliasMap(sections: { ok: boolean; accounts?: SettingsAccount[] }[]) {
  const map = new Map<string, string>();
  for (const s of sections) for (const a of s.accounts ?? []) map.set(a.id, a.alias);
  return map;
}
export function eventSummary(event: SubBatonEvent, aliases: ReadonlyMap<string, string> = new Map()) {
  const name = (id?: string) => (id ? (aliases.get(id) ?? "unknown account") : "");
  const who = event.account ? name(event.account) : (event.alias ?? "");
  const target = event.target ? name(event.target) : event.targetAlias;
  return [
    event.kind === "unknown" ? "Event" : humanize(event.kind).replace(/^./, (c) => c.toUpperCase()),
    who && target ? `${who} → ${target}` : who || target || "",
    event.reason ? `(${humanize(event.reason)})` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function planSummary(plan: AutoPlan) {
  const alias = (id: string | null | undefined) =>
    id ? (plan.why.candidates.find((c) => c.id === id)?.alias ?? id) : null;
  const target = alias(plan.decision.target);
  const decision =
    plan.decision.action === "switch" && target ? `switch to ${target}` : humanize(plan.decision.action);
  return {
    headline: `Decision: ${decision} (${humanize(plan.decision.reason)})`,
    lines: [
      `Execution ${plan.executionEnabled ? "enabled" : "disabled"}; process state ${humanize(plan.processState)}.`,
      `Strategy ${plan.why.effectiveStrategy}; usage rate ${plan.why.rate.percentPerHour === undefined ? "unknown" : `${Math.round(plan.why.rate.percentPerHour * 10) / 10} points/hour`} (${humanize(plan.why.rate.confidence)}, ${plan.why.rate.sampleCount} samples).`,
      `Cooldown ${plan.why.cooldown.passed ? "passed" : `${Math.ceil(plan.why.cooldown.remainingSeconds / 60)} min left`}${plan.why.cooldown.overridden ? " (overridden)" : ""}; margin ${plan.why.margin.passed ? "met" : "not met"} (needs ${plan.why.margin.required}).`,
      ...(plan.why.weeklyPriorityAccounts.length
        ? [`Weekly reset priority: ${plan.why.weeklyPriorityAccounts.map((id) => alias(id)).join(", ")}.`]
        : []),
    ],
    candidates: plan.why.candidates.map((c) => ({
      id: c.id,
      title: `${c.alias}: ${c.eligible ? "eligible" : "excluded"}${c.headroom === undefined ? "" : `, headroom ${Math.round(c.headroom * 10) / 10}`}`,
      reasons: c.reasons.map(humanize),
      windows: c.windows.map(
        (w) =>
          `${w.id}: ${w.usedPercent === undefined ? "unknown" : `${w.usedPercent}%`}${w.threshold ? ` of ${w.threshold.value}% (${humanize(w.threshold.source)})` : ""}, ${w.state}${w.inferred ? ", inferred" : ""}`,
      ),
      forecast:
        c.forecast.predictedUnused === undefined
          ? null
          : `Forecast unused ${Math.round(c.forecast.predictedUnused * 10) / 10} points before ${c.forecast.window ?? "weekly"} reset${c.forecast.priority ? " (priority)" : ""}.`,
    })),
    sequences: plan.why.sequences.map(
      (s) => `${s.order.map((id) => alias(id)).join(" → ")}: ${Math.round(s.expiredQuota * 10) / 10} points expire`,
    ),
  };
}

/**
 * Rebases an order draft onto the current accounts (review L3): kept accounts keep the drafted
 * order, new accounts are appended in their saved order, removed ones are dropped.
 */
export function rebaseOrder(drafted: string[], current: string[]): { ids: string[]; changed: boolean } {
  const kept = drafted.filter((id) => current.includes(id));
  const ids = [...kept, ...current.filter((id) => !kept.includes(id))];
  return { ids, changed: ids.length !== drafted.length || ids.some((id, i) => id !== drafted[i]) };
}
/** Draft keys whose stored value differs between the draft's base section and a fresher one. */
export function changedSince(base: SettingsSection, fresh: SettingsSection, draft: Draft): Set<string> {
  const changed = new Set<string>();
  for (const { path } of Object.values(draft))
    if (JSON.stringify(storedValue(base, path)) !== JSON.stringify(storedValue(fresh, path))) changed.add(draftKey(path));
  return changed;
}
/** Draft entries that turn automatic switching on or off; Apply confirms these (review I4). */
export function autoEnabledChanges(draft: Draft): boolean[] {
  return Object.values(draft)
    .filter(({ path, value }) => path.length === 1 && path[0] === "autoEnabled" && typeof value === "boolean")
    .map(({ value }) => value as boolean);
}

