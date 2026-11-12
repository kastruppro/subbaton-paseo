import { z } from "zod";
import type { ActionResult, Provider } from "../shared/contracts.js";
import {
  actionNames,
  autoSummarySchema,
  dictionarySchema,
  identifierPattern,
  pollerSummarySchema,
  settingsFieldSchema,
  settingsSectionSchema,
  type Leaf,
  type SettingsField,
  type SettingsSection,
  type SettingsResult,
} from "../shared/settings.js";
import { settingsMessages } from "../shared/settings-messages.js";

const object = z.record(z.string(), z.unknown());
const rawSection = z.object({
  schemaVersion: z.number().int(),
  supportedSchemaVersion: z.number().int(),
  exists: z.boolean(),
  migrationRequired: z.boolean(),
  readOnly: z.boolean(),
  revision: z.string(),
  values: object.nullable(),
  defaults: object.nullable().default(null),
  effective: object.nullable().default(null),
  fields: z.array(z.unknown()).max(128),
  actions: z
    .array(z.object({ name: z.string().max(64) }))
    .max(16)
    .default([]),
  auto: z.unknown().optional(),
});
const rawError = z.object({
  error: z.object({ code: z.string().max(128) }),
});
const rawDocument = z.object({
  providers: z.record(z.string(), z.unknown()),
  poller: z.unknown().optional(),
});

class InvalidSection extends Error {}
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const at = (root: unknown, segments: string[]): unknown => {
  let value = root;
  for (const segment of segments) {
    if (!isObject(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
};
export const isTemplateChild = (field: SettingsField) =>
  /<(window|model)>/.test(field.path);
const accountPrefix = "accounts.<account>.";

/** Checks one stored leaf against its field type; returns undefined for missing/unknown types. */
function storedLeaf(field: SettingsField, value: unknown): Leaf | undefined {
  if (value === undefined || field.type === "unknown") return undefined;
  if (value === null && field.nullable) return null;
  const valid = (() => {
    switch (field.type) {
      case "boolean":
        return typeof value === "boolean";
      case "number":
      case "integer":
        return typeof value === "number" && Number.isFinite(value);
      case "string":
        return (
          typeof value === "string" &&
          value.length <= 512 &&
          (!field.enum || field.enum.includes(value))
        );
      case "array":
        return (
          Array.isArray(value) &&
          value.length <= 256 &&
          value.every((v) => typeof v === "string" && v.length <= 512)
        );
      case "object":
        return dictionarySchema.safeParse(value).success;
    }
  })();
  if (!valid) throw new InvalidSection();
  return value as Leaf;
}
function extract(
  fields: SettingsField[],
  root: unknown,
  account: boolean,
): Record<string, Leaf> {
  const result: Record<string, Leaf> = {};
  for (const field of fields) {
    if (isTemplateChild(field)) continue;
    if (field.path.startsWith(accountPrefix) !== account) continue;
    const path = account ? field.path.slice(accountPrefix.length) : field.path;
    if (!account && path.startsWith("accounts.")) continue;
    const value = storedLeaf(field, at(root, path.split(".")));
    if (value !== undefined) result[path] = value;
  }
  return result;
}

const sectionError = (provider: Provider, code: string) => ({
  ok: false as const,
  provider,
  error: settingsError(code),
});
export function settingsError(code: string): ActionResult {
  return {
    outcome: "error",
    code: settingsMessages[code] ? code : "settingsUnavailable",
    message:
      settingsMessages[code] ??
      "This provider's settings are unavailable. Check storage access and configuration, then reload.",
  };
}

/** Projects one CLI provider section onto the metadata-described fields only. */
export function normalizeSection(
  provider: Provider,
  raw: unknown,
): SettingsSection {
  const parsed = rawSection.safeParse(raw);
  if (!parsed.success) throw new InvalidSection();
  const section = parsed.data;
  const fields: SettingsField[] = [];
  for (const entry of section.fields) {
    if (!isObject(entry) || typeof entry.path !== "string") continue;
    if (!entry.path.startsWith("<provider>.")) continue;
    const field = settingsFieldSchema.safeParse({
      ...entry,
      path: entry.path.slice("<provider>.".length),
    });
    if (!field.success) throw new InvalidSection();
    fields.push(field.data);
  }
  const values = section.values ?? {};
  const order = Array.isArray(values.order)
    ? values.order.filter((v): v is string => typeof v === "string")
    : [];
  const rows = isObject(values.accounts) ? values.accounts : {};
  const ids = [
    ...order.filter((id) => Object.hasOwn(rows, id)),
    ...Object.keys(rows).filter((id) => !order.includes(id)),
  ];
  const accounts = ids.map((id) => {
    const row = rows[id];
    if (!identifierPattern.test(id) || !isObject(row)) throw new InvalidSection();
    return {
      id,
      alias: String(row.alias ?? id).slice(0, 512),
      quarantined: row.quarantined === true,
      deviceBlocked: row.deviceBlocked === true,
      needsLogin: row.needsLogin === true,
      values: extract(fields, row, true),
      effective: extract(fields, at(section.effective, ["accounts", id]), true),
    };
  });
  const auto = autoSummarySchema.safeParse(section.auto ?? { paused: false });
  const result = settingsSectionSchema.safeParse({
    ok: true,
    provider,
    revision: section.revision,
    exists: section.exists,
    readOnly: section.readOnly,
    migrationRequired: section.migrationRequired,
    newerSchema: section.schemaVersion > section.supportedSchemaVersion,
    fields,
    values: extract(fields, values, false),
    defaults: extract(fields, section.defaults, false),
    effective: extract(fields, section.effective, false),
    accounts,
    actions: section.actions
      .map((a) => a.name)
      .filter((name): name is (typeof actionNames)[number] =>
        (actionNames as readonly string[]).includes(name),
      ),
    auto: auto.success ? auto.data : { paused: false, pauseReason: null, pausedAt: null, lastAutomaticSwitchAt: null, recentAutomaticSwitches: 0, flapLimit: null },
  });
  if (!result.success) throw new InvalidSection();
  return result.data;
}

export function normalizeDocument(raw: unknown): NonNullable<SettingsResult["data"]> | null {
  const parsed = rawDocument.safeParse(raw);
  if (!parsed.success) return null;
  const providers = (["claude", "codex", "agy"] as const).map((provider) => {
    const section = parsed.data.providers[provider];
    const error = rawError.safeParse(section);
    if (error.success) return sectionError(provider, error.data.error.code);
    try {
      return normalizeSection(provider, section);
    } catch {
      return sectionError(provider, "invalidResponse");
    }
  });
  const poller = pollerSummarySchema.safeParse(parsed.data.poller);
  return { providers, poller: poller.success ? poller.data : null };
}

type Validation =
  | { ok: true; changes: Record<string, Leaf> }
  | { ok: false; code: string };
const pointer = (segments: string[]) =>
  "/" + segments.map((s) => s.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");

function inRange(field: SettingsField, value: number) {
  if (field.minimum !== undefined && value < field.minimum) return false;
  if (field.maximum !== undefined && value > field.maximum) return false;
  if (field.type === "integer" && !Number.isInteger(value)) return false;
  if (field.allowedRanges && !field.allowedRanges.some(([lo, hi]) => value >= lo && value <= hi)) return false;
  return true;
}
export function validValue(
  section: SettingsSection,
  field: SettingsField,
  value: Leaf,
  child?: SettingsField,
): boolean {
  if (value === null) return field.nullable;
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && inRange(field, value);
    case "string":
      return typeof value === "string" && (!field.enum || field.enum.includes(value));
    case "array": {
      if (!Array.isArray(value)) return false;
      if (field.path !== "order") return true;
      const ids = section.accounts.map((a) => a.id);
      return value.length === ids.length && new Set(value).size === ids.length && value.every((v) => ids.includes(v));
    }
    case "object": {
      const parsed = dictionarySchema.safeParse(value);
      if (!parsed.success || !child) return false;
      const entries = Object.values(parsed.data);
      return (
        entries.filter((v) => v !== null).length <= 128 &&
        entries.every((v) => validValue(section, child, v, undefined))
      );
    }
    default:
      return false;
  }
}
/** Resolves a field for a provider-relative path, or the dictionary child template. */
export function resolveField(section: SettingsSection, path: string[]) {
  const template = path[0] === "accounts" ? ["accounts", "<account>", ...path.slice(2)] : path;
  const key = template.join(".");
  const exact = section.fields.find((f) => f.path === key && !isTemplateChild(f));
  const childOf = (parent: string) =>
    section.fields.find((f) => isTemplateChild(f) && f.path.startsWith(parent + ".<"));
  if (exact) return { field: exact, child: exact.type === "object" ? childOf(exact.path) : undefined };
  const parent = section.fields.find(
    (f) => f.type === "object" && !isTemplateChild(f) && f.path === template.slice(0, -1).join("."),
  );
  const child = parent && childOf(parent.path);
  return child ? { field: child, child: undefined } : null;
}

export function validateChanges(
  section: SettingsSection,
  changes: { path: string[]; value: Leaf }[],
): Validation {
  if (section.readOnly) return { ok: false, code: "readOnly" };
  const result: Record<string, Leaf> = {};
  const touched: string[] = [];
  for (const { path, value } of changes) {
    if (path[0] === "accounts") {
      if (path.length < 3 || !section.accounts.some((a) => a.id === path[1]))
        return { ok: false, code: "unknownAccount" };
    }
    const resolved = resolveField(section, path);
    if (!resolved || resolved.field.type === "unknown") return { ok: false, code: "invalidSetting" };
    if (!validValue(section, resolved.field, value, resolved.child)) return { ok: false, code: "invalidSetting" };
    const canonical = path.join("/");
    if (touched.some((t) => t === canonical || t.startsWith(canonical + "/") || canonical.startsWith(t + "/")))
      return { ok: false, code: "overlappingChanges" };
    touched.push(canonical);
    result[pointer([section.provider, ...path])] = value;
  }
  return { ok: true, changes: result };
}
