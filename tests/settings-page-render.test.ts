import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDocument, normalizeSection } from "../server/settings.js";
import { settingsDocument, claudeSection } from "./settings-fixtures.js";
import { loadRenderer } from "./render/load.js";
import { settingsSections, providerFieldsBySection } from "../client/settings-sections.js";
import { providerGroups } from "../client/settings-model.js";

const extra = (path: string, type = "boolean") => ({
  path: `<provider>.${path}`, type, default: type === "boolean" ? false : 1, unit: "none", scope: "provider", nullable: false,
  runtime: "persistedOnly", title: `Title of ${path}`, description: `Field ${path}.`,
});
const claude = () => {
  const raw = claudeSection() as { fields: unknown[] };
  raw.fields = [...raw.fields, extra("auto.creditsFallback"), extra("daemonAutoRestart"), extra("inactiveIntervalHours", "number"), extra("notifications.switchFailed"), extra("somethingNewFromTheCli")];
  return raw;
};
const doc = () => normalizeDocument(settingsDocument(claude()));

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const headings = (html: string) => {
  const out: { level: number; text: string }[] = [];
  for (const m of html.matchAll(/<(h\d|div)\b[^>]*?(?:aria-level="(\d)"|role="heading")[^>]*>(.*?)<\/\1>/g)) {
    const attrs = m[0];
    const level = Number(/aria-level="(\d)"/.exec(attrs)?.[1] ?? "0");
    if (level) out.push({ level, text: decode(m[3]!.replace(/<[^>]+>/g, "")) });
  }
  return out;
};

let html = "";
test("render the real settings page once", async () => {
  html = (await loadRenderer())(doc());
  assert.ok(html.length > 5000);
});

test("SP-4: the rendered page has all seven section headings, in order, as the only level-1 headings", () => {
  const level1 = headings(html).filter((h) => h.level === 1).map((h) => h.text);
  assert.deepEqual(level1, settingsSections.map((s) => s.title));
});

test("SP-4: every previously reachable part is found in the rendered markup", () => {
  const text = decode(html);
  const has = (needle: string) => text.includes(needle);
  const parts: Record<string, string[]> = {
    "cli-binary": ["SubBaton binary"],
    "cli-allow-path": ["Allow verified PATH lookup"],
    "display-items": ["Always visible items", "Claude · 5-hour limit"],
    "display-thresholds": ["Threshold colours", "Warning at used %", "Danger at used %"],
    "display-reload": ["Reload display preferences"],
    "display-reset-invalid": [],
    "account-order": ["Account order"],
    "account-cards": ["work", "home"],
    "add-account": ["Logins happen on the Mac"],
    "auto-fields": ["Automatic switching", "Credits fallback: Off", "Default threshold"],
    "auto-paused-resume": ["Automatic switching paused"],
    "auto-plan": ["Automatic plan (read only)"],
    "handoff-section": ["Coordinated handoff", "Continue Codex agents that hit a usage limit"],
    "codex-fields": ["Title of daemonAutoRestart"],
    "poller-status": ["Installed"],
    "poller-lifecycle": ["Reinstall", "Uninstall"],
    "inactive-polling-fields": ["Title of inactiveIntervalHours"],
    "notification-fields": ["Title of notifications.switchFailed"],
    "recent-events": ["Automatic switch"],
  };
  const { legacyReachable } = require_manifest();
  assert.deepEqual(Object.keys(parts).sort(), [...legacyReachable].sort(), "the checklist covers all 19 parts");
  for (const [part, needles] of Object.entries(parts))
    for (const needle of needles) assert.ok(has(needle), `${part}: "${needle}" is not on the rendered page`);
});

test("SP-4: every CLI field of the provider is rendered with its title", () => {
  const section = normalizeSection("claude", claude());
  const titles = providerGroups(section, {}).flatMap((g) => g.fields.map((f) => f.field.title));
  assert.ok(titles.length >= 10);
  const text = decode(html);
  for (const title of new Set(titles)) {
    // Credits fallback is shown as "Credits fallback: On/Off" (its title carries the state)
    const shown = title === "Title of auto.creditsFallback" ? "Credits fallback: " : title;
    assert.ok(text.includes(shown), `field "${title}" is missing from the rendered page`);
  }
  // and every field sits under the section the model says
  const bySection = providerFieldsBySection(providerGroups(section, {}));
  assert.ok(bySection.auto.length > 0 && bySection.handoff.length > 0 && bySection.poller.length > 0 && bySection.events.length > 0);
});

test("SP-5: one heading pattern: page sections are level 1, every sub-group is level 2", () => {
  const all = headings(html);
  const level2 = all.filter((h) => h.level === 2).map((h) => h.text);
  for (const sub of ["Always visible items", "Threshold colours", "Coordinated handoff", "Automatic plan (read only)", "Provider", "Automatic switching", "Thresholds"])
    assert.ok(level2.includes(sub), `"${sub}" should be a level-2 heading; found ${JSON.stringify(level2)}`);
  assert.ok(all.every((h) => h.level === 1 || h.level === 2));
  const level1 = all.filter((h) => h.level === 1).map((h) => h.text);
  for (const sub of level2) assert.ok(!level1.includes(sub) || settingsSections.some((s) => s.title === sub), sub);
});

import { legacyReachable } from "../client/settings-sections.js";
function require_manifest() { return { legacyReachable }; }
