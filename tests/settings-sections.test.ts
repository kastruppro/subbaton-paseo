import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSection } from "../server/settings.js";
import { providerGroups, groupOrder } from "../client/settings-model.js";
import {
  settingsSections,
  sectionOfGroup,
  sectionOfField,
  pageManifest,
  legacyReachable,
  providerFieldsBySection,
} from "../client/settings-sections.js";
import { claudeSection } from "./settings-fixtures.js";

const extra = (path: string, type = "boolean") => ({
  path: `<provider>.${path}`, type, default: type === "boolean" ? false : 1, unit: "none", scope: "provider", nullable: false,
  runtime: "persistedOnly", title: path, description: `Field ${path}.`,
});
const fullSection = () => {
  const raw = claudeSection() as { fields: unknown[]; values: Record<string, unknown> };
  raw.fields = [...raw.fields,
    extra("auto.creditsFallback"), extra("daemonAutoRestart"), extra("inactiveIntervalHours", "number"),
    extra("notifications.switchFailed"), extra("somethingNewFromTheCli")];
  return normalizeSection("claude", raw);
};

test("one page, six numbered sections in the owner's order plus the CLI binary, each with a one-sentence purpose", () => {
  assert.deepEqual(settingsSections.map((s) => s.id), ["display", "accounts", "auto", "handoff", "poller", "events", "cli"]);
  assert.deepEqual(settingsSections.map((s) => s.title), [
    "Footer & display", "Accounts", "Automatic switching", "Codex & agy handoff", "Background poller", "Notifications & events", "SubBaton CLI",
  ]);
  for (const s of settingsSections) {
    assert.ok(s.summary.length > 10, s.id);
    assert.equal(s.summary.split(/[.!?](\s|$)/).filter((p) => p.trim().length > 3).length, 1, `${s.id} has one sentence: ${s.summary}`);
    assert.ok(s.summary.endsWith("."), s.id);
  }
});

test("every provider field group maps to a section, and unknown CLI fields still show up", () => {
  for (const group of groupOrder) assert.ok(sectionOfGroup[group], group);
  assert.equal(sectionOfGroup["Automatic switching"], "auto");
  assert.equal(sectionOfGroup["Thresholds"], "auto");
  assert.equal(sectionOfGroup["Weekly reset priority"], "auto");
  assert.equal(sectionOfGroup["Codex"], "handoff");
  assert.equal(sectionOfGroup["Inactive polling"], "poller");
  assert.equal(sectionOfGroup["Notifications"], "events");
  assert.equal(sectionOfGroup["Other settings"], "auto");
  assert.equal(sectionOfField("auto.creditsFallback"), "auto");
  assert.equal(sectionOfField("somethingNewFromTheCli"), "auto");
});

test("every CLI field of every provider is on the page exactly once (nothing dropped, nothing duplicated: same multiset)", () => {
  const section = fullSection();
  const groups = providerGroups(section, {});
  const all = groups.flatMap((g) => g.fields.map((f) => f.key)).sort();
  const bySection = providerFieldsBySection(groups);
  const placed = Object.values(bySection).flatMap((gs) => gs.flatMap((g) => g.fields.map((f) => f.key))).sort();
  assert.deepEqual(placed, all);
  const keys = (id: keyof typeof bySection) => bySection[id].flatMap((g) => g.fields.map((f) => f.key));
  assert.ok(keys("auto").includes("autoEnabled"));
  assert.ok(keys("auto").includes("auto/creditsFallback"), "Credits fallback sits with automatic switching");
  assert.ok(keys("auto").includes("thresholds/global"));
  assert.ok(keys("handoff").includes("daemonAutoRestart"));
  assert.ok(keys("poller").includes("inactiveIntervalHours"));
  assert.ok(keys("events").includes("notifications/switchFailed"));
  assert.ok(keys("auto").includes("somethingNewFromTheCli"));
});

test("everything that was reachable on the two old screens is on the single page", () => {
  const onPage = new Set(Object.values(pageManifest).flat());
  assert.equal(legacyReachable.length >= 15, true);
  for (const part of legacyReachable) assert.ok(onPage.has(part), `missing on the page: ${part}`);
  // sections hold what they claim
  assert.ok(pageManifest.display.includes("display-items") && pageManifest.display.includes("display-thresholds"));
  assert.ok(pageManifest.accounts.includes("account-cards") && pageManifest.accounts.includes("account-order") && pageManifest.accounts.includes("add-account"));
  assert.ok(pageManifest.auto.includes("auto-paused-resume") && pageManifest.auto.includes("auto-plan"));
  assert.ok(pageManifest.handoff.includes("handoff-section"));
  assert.ok(pageManifest.cli.includes("cli-binary"));
});
