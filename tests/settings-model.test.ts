import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSection, normalizeDocument } from "../server/settings.js";
import {
  accountBadges,
  accountFields,
  draftChanges,
  eventSummary,
  formatLeaf,
  humanize,
  move,
  orderView,
  parseNumber,
  planSummary,
  providerGroups,
  rangeHint,
  setDraft,
  storedValue,
  validKey,
  rebaseOrder,
  changedSince,
  autoEnabledChanges,
  aliasMap,
  type Draft,
} from "../client/settings-model.js";
import { claudeSection, settingsDocument, accountA, accountB, plan } from "./settings-fixtures.js";
import { autoPlanSchema } from "../shared/settings.js";

const section = () => normalizeSection("claude", claudeSection());
const find = (draft: Draft = {}) => {
  const groups = providerGroups(section(), draft);
  return (path: string) => groups.flatMap((g) => g.fields).find((f) => f.key === path.replaceAll(".", "/"))!;
};

test("provider fields are grouped from CLI metadata and keep CLI titles and descriptions", () => {
  const groups = providerGroups(section(), {});
  assert.deepEqual(groups.map((g) => g.title), [
    "Automatic switching",
    "Thresholds",
    "Weekly reset priority",
    "Inactive polling",
    "Notifications",
  ]);
  const auto = find()("autoEnabled");
  assert.equal(auto.field.title, "Automatic switching");
  assert.match(auto.field.description, /automatic policy engine/);
  assert.equal(groups.flatMap((g) => g.fields).some((f) => f.field.path.includes("<")), false);
  assert.equal(groups.flatMap((g) => g.fields).some((f) => f.field.path.startsWith("accounts.")), false);
});

test("boolean fields render as switches with their runtime badge", () => {
  const field = find()("weeklyResetPriority.enabled");
  assert.deepEqual(field.control, { kind: "switch" });
  assert.equal(field.value, true);
  assert.equal(field.runtime, "Stored only");
  assert.equal(find()("inactiveIntervalHours").runtime, "Active now");
});

test("number ranges, integers and gaps follow the CLI bounds", () => {
  const cooldown = find()("cooldownMinutes");
  assert.deepEqual(cooldown.control, { kind: "number", integer: false, minimum: 0, maximum: 1440 });
  assert.equal(rangeHint(cooldown.field), "0 to 1440 (minutes).");
  assert.deepEqual(parseNumber("2.5", cooldown.field), { value: 2.5 });
  assert.ok("error" in parseNumber("1441", cooldown.field));
  assert.ok("error" in parseNumber("", cooldown.field));
  assert.ok("error" in parseNumber("1e3", cooldown.field));
  const horizon = find()("weeklyResetPriority.horizonDays");
  assert.ok("error" in parseNumber("2.5", horizon.field));
  assert.deepEqual(parseNumber("7", horizon.field), { value: 7 });
  const interval = find()("inactiveIntervalHours");
  assert.match(rangeHint(interval.field), /^0 or 1 to 720/);
  assert.ok("error" in parseNumber("0.5", interval.field));
  assert.deepEqual(parseNumber("0", interval.field), { value: 0 });
});

test("enums render as selects with CLI enum descriptions", () => {
  const strategy = find()("strategy");
  assert.equal(strategy.control.kind, "select");
  assert.ok(strategy.control.kind === "select" && strategy.control.options.length === 5);
  assert.equal(
    strategy.control.kind === "select" && strategy.control.options.find((o) => o.value === "consume-first")?.description,
    "CLI description of consume-first.",
  );
});

test("nullable account thresholds show inherit and accept empty as null", () => {
  const s = section();
  const work = accountFields(s, s.accounts[0]!, {});
  const global = work.find((f) => f.key.endsWith("thresholds/global"))!;
  assert.deepEqual(global.path, ["accounts", accountA, "thresholds", "global"]);
  assert.equal(global.inherits, true);
  assert.equal(formatLeaf(global.value, global.field), "inherit");
  assert.deepEqual(parseNumber("", global.field), { value: null });
  assert.match(rangeHint(global.field), /Empty inherits/);
  const home = accountFields(s, s.accounts[1]!, {});
  assert.equal(home.find((f) => f.key.endsWith("thresholds/global"))!.value, 85);
  assert.equal(home.find((f) => f.key.endsWith("priority"))!.value, 7);
});

test("window and model dictionaries offer knownKeys plus stored keys and a child template", () => {
  const windows = find()("thresholds.windows");
  assert.equal(windows.control.kind, "dictionary");
  assert.ok(windows.control.kind === "dictionary");
  assert.deepEqual(windows.control.keys, ["5h", "7d", "five_hour", "seven_day", "weekly_scoped:Opus-4.5"]);
  assert.equal(windows.control.child?.maximum, 99.9);
  assert.equal(windows.control.child?.nullable, true);
  const models = find()("thresholds.models");
  assert.ok(models.control.kind === "dictionary" && models.control.keys.includes("Sonnet"));
  assert.equal(storedValue(section(), ["thresholds", "windows", "7d"]), 90);
  assert.equal(storedValue(section(), ["thresholds", "windows", "5h"]), null);
  assert.equal(storedValue(section(), ["accounts", accountB, "thresholds", "windows", "5h"]), 70);
  assert.ok(validKey("gemini-2.5"));
  assert.ok(!validKey("bad key"));
});

test("account order lists every account and moves within bounds", () => {
  const s = section();
  const order = orderView(s, {})!;
  assert.deepEqual(order.accounts.map((a) => a.alias), ["work", "home"]);
  const moved = move([accountA, accountB], 0, 1);
  assert.deepEqual(moved, [accountB, accountA]);
  assert.deepEqual(move(moved, 0, -1), moved);
  const draft = setDraft({}, s, ["order"], moved, storedValue(s, ["order"]));
  assert.deepEqual(orderView(s, draft)!.accounts.map((a) => a.alias), ["home", "work"]);
  assert.deepEqual(accountBadges(s.accounts[1]!), ["Quarantined", "Needs login"]);
});

test("drafts drop no-op edits and replace overlapping dictionary writes", () => {
  const s = section();
  let draft = setDraft({}, s, ["autoEnabled"], true, false);
  draft = setDraft(draft, s, ["autoEnabled"], false, false);
  assert.deepEqual(draft, {});
  draft = setDraft(draft, s, ["thresholds", "windows", "5h"], 80, null);
  draft = setDraft(draft, s, ["thresholds", "windows"], { "5h": null, "7d": null }, { "5h": null, "7d": 90 });
  assert.deepEqual(Object.keys(draft), ["thresholds/windows"]);
  draft = setDraft(draft, s, ["strategy"], "consume-first", "best");
  assert.deepEqual(draftChanges(draft), [
    { path: ["thresholds", "windows"], value: { "5h": null, "7d": null } },
    { path: ["strategy"], value: "consume-first" },
  ]);
  assert.equal(find(draft)("strategy").pending, true);
  assert.equal(find(draft)("strategy").value, "consume-first");
});

test("read-only, error and unsupported sections stay visible without hiding others", () => {
  const doc = normalizeDocument(settingsDocument())!;
  assert.equal(doc.providers[1]?.ok, false);
  assert.ok(doc.providers[2]?.ok && doc.providers[2].readOnly);
  const future = claudeSection();
  (future.fields as unknown[]).push({ path: "<provider>.newThing", type: "matrix", title: "New", runtime: "later" });
  const s = normalizeSection("claude", future);
  const other = providerGroups(s, {}).find((g) => g.title === "Other settings")!;
  assert.equal(other.fields[0]?.control.kind, "unsupported");
  assert.equal(other.fields[0]?.runtime, "Runtime unknown");
});

test("events and plans get readable summaries from codes", () => {
  assert.equal(humanize("thresholdReached"), "threshold reached");
  assert.equal(
    eventSummary({ id: "1", at: 1, provider: "claude", kind: "automaticSwitch", alias: "work", targetAlias: "home", reason: "thresholdReached" }),
    "Automatic switch work → home (threshold reached)",
  );
  const summary = planSummary(autoPlanSchema.parse(plan));
  assert.equal(summary.headline, "Decision: switch to home (threshold reached)");
  assert.match(summary.lines[1]!, /usage rate unknown/);
  assert.match(summary.lines.at(-1)!, /Weekly reset priority: home/);
  assert.match(summary.candidates[0]!.windows[0]!, /97% of 95% \(provider global\), fresh/);
  assert.equal(summary.sequences[0], "home → work: 10.1 points expire");
});

test("order drafts rebase onto the current accounts", () => {
  assert.deepEqual(rebaseOrder(["b", "a"], ["a", "b"]), { ids: ["b", "a"], changed: false });
  assert.deepEqual(rebaseOrder(["b", "a"], ["a", "b", "c"]), { ids: ["b", "a", "c"], changed: true });
  assert.deepEqual(rebaseOrder(["b", "x", "a"], ["a", "b"]), { ids: ["b", "a"], changed: true });
});

test("after a conflict only draft fields whose stored value changed are marked", () => {
  const base = section();
  const values = structuredClone(claudeSection().values) as Record<string, any>;
  values.cooldownMinutes = 9;
  values.strategy = "best";
  const fresh = normalizeSection("claude", claudeSection("r2", values));
  let draft = setDraft({}, base, ["cooldownMinutes"], 12, 5);
  draft = setDraft(draft, base, ["strategy"], "consume-first", "best");
  const changed = changedSince(base, fresh, draft);
  assert.deepEqual([...changed], ["cooldownMinutes"]);
  const cooldown = providerGroups(fresh, draft, changed).flatMap((g) => g.fields).find((f) => f.key === "cooldownMinutes")!;
  assert.equal(cooldown.changedElsewhere, true);
  assert.equal(cooldown.value, 12);
});

test("Apply lists automatic switching changes for confirmation", () => {
  const s = section();
  assert.deepEqual(autoEnabledChanges(setDraft({}, s, ["autoEnabled"], true, false)), [true]);
  assert.deepEqual(autoEnabledChanges(setDraft({}, s, ["strategy"], "consume-first", "best")), []);
});

test("event rows resolve account IDs to the aliases settings reports", () => {
  const aliases = aliasMap([section()]);
  assert.equal(
    eventSummary({ id: "1", at: 1, provider: "claude", kind: "automaticSwitch", account: accountA, target: accountB, reason: "thresholdReached" }, aliases),
    "Automatic switch work → home (threshold reached)",
  );
  assert.match(eventSummary({ id: "2", at: 1, provider: "codex", kind: "needsLogin", account: "99999999-9999-4999-8999-999999999999" }, aliases), /unknown account/);
});

test("fields carry the CLI's runtimeDetail", () => {
  const raw = claudeSection();
  (raw.fields as Record<string, unknown>[]).find((f) => f.path === "<provider>.notifications.enabled")!.runtimeDetail = "Recorded in the event log.";
  const s = normalizeSection("claude", raw);
  assert.equal(s.fields.find((f) => f.path === "notifications.enabled")?.runtimeDetail, "Recorded in the event log.");
});

test("rename input preserves the text sent across refused writes and background revisions", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../client/control.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('key={`${account.id}:${renaming}`} label="New account name" initialValue={newAlias}'));
  assert.ok(source.includes('alias: newAlias, expectedRevision: section.revision'));
  assert.ok(source.includes('if (response.result.outcome === "success") await reload();'));
  assert.ok(source.includes('setNewAlias(account.alias); setRenameError(null); setRenaming(!renaming);'));
});
