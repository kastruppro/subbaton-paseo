import test from "node:test";
import assert from "node:assert/strict";
import { accountSchema, statusSchema, windowSchema, type Account, type Window } from "../shared/contracts.js";
import { windowPresentation, windowTitle, chooseItems, shortWarning } from "../client/display.js";
import { footerCell, footerLabel, footerSpeech } from "../client/footer-model.js";
import { windowLabel, windowLongLabel, miniWindows, otherAccountSummary, rowGlyph, geminiNotice } from "../client/popover-model.js";

const w = (id: string, patch: Record<string, unknown> = {}) => ({
  id, label: id, usedPercent: 10, resetsAt: null, stale: false, fetchedAt: 1, ...patch,
});
const acct = (windows: unknown[], patch: Record<string, unknown> = {}): Account =>
  accountSchema.parse({ id: "a", alias: "Main", email: null, active: true, enabled: true, health: "ok", plan: null, loginExpiresAt: null, usageStatus: "ok", windows, ...patch });
const modelQuota = (patch: Record<string, unknown> = {}) =>
  w("gemini:unknown", { label: "Gemini (model quota)", usedPercent: 35, quotaSource: "models", window: "unknown", ...patch });

// fixtures: an old payload, a payload with a model-quota window, one with percent null
const oldPayload = () => acct([w("claude-gpt:5h", { usedPercent: 80 })]);
const withModel = () => acct([w("claude-gpt:5h", { usedPercent: 80 }), modelQuota()]);
const nullPercent = () => acct([w("claude-gpt:5h", { usedPercent: 80 }), modelQuota({ usedPercent: null })]);

test("decoding: quotaSource and window are optional and garbage is ignored", () => {
  const parsed = windowSchema.parse(modelQuota());
  assert.equal(parsed.quotaSource, "models");
  assert.equal(parsed.window, "unknown");
  const old = windowSchema.parse(w("claude-gpt:5h"));
  assert.equal(old.quotaSource, undefined);
  assert.equal(old.window, undefined);
  const bad = windowSchema.parse(w("gemini:unknown", { quotaSource: 7, window: { x: 1 } }));
  assert.equal(bad.quotaSource, undefined);
  assert.equal(bad.window, undefined);
  const status = statusSchema.parse({ cacheOnly: true, generatedAt: 1, providers: [{ provider: "agy", cacheStatus: "available", accounts: [withModel()] }] });
  assert.equal(status.providers[0]!.accounts[0]!.windows[1]!.quotaSource, "models");
});

test("labels: short 'Gemini' with no duration, long 'Gemini (model quota)', picker title", () => {
  const model = windowSchema.parse(modelQuota());
  assert.equal(windowLabel("agy", model), "Gemini");
  assert.equal(windowLongLabel("agy", model), "Gemini (model quota)");
  assert.equal(windowLabel("agy", windowSchema.parse(w("claude-gpt:5h"))), "C/GPT 5h");
  assert.equal(windowLongLabel("agy", windowSchema.parse(w("claude-gpt:5h"))), "C/GPT 5h");
  assert.equal(windowTitle("gemini:unknown"), "Gemini (model quota)");
  assert.equal(windowLabel("agy", windowSchema.parse(modelQuota({ id: "gemini:unknown", windowSeconds: 18000 }))), "Gemini");
});

test("the model-quota row never gets a duration, a pace tick or a reset time", () => {
  const model = windowSchema.parse(modelQuota());
  const view = windowPresentation("agy", model, 80, 100, false, 1000);
  assert.equal(view.tick, null);
  assert.equal(view.reset, "reset unknown");
  assert.equal(view.percent, "35%");
  const unknown = windowPresentation("agy", windowSchema.parse(modelQuota({ usedPercent: null })), 80, 100, false, 1000);
  assert.equal(unknown.percent, "—");
  assert.equal(unknown.fillPercent, 0);
});

test("compact summaries use the model-quota row in the Gemini slot; a real Gemini window wins", () => {
  assert.deepEqual(miniWindows("agy", withModel().windows).map((x) => x.id), ["gemini:unknown", "claude-gpt:5h"]);
  const both = acct([w("claude-gpt:5h"), modelQuota(), w("gemini:5h")]);
  assert.deepEqual(miniWindows("agy", both.windows).map((x) => x.id), ["gemini:5h", "claude-gpt:5h"]);
  assert.equal(otherAccountSummary("agy", acct([w("claude-gpt:5h", { usedPercent: 80 }), modelQuota()], { active: false })), "Gemini 35% · C/GPT 5h 80%");
  assert.equal(otherAccountSummary("agy", acct([modelQuota({ usedPercent: null })], { active: false })), "");
});

test("the state glyph counts the model-quota window like any other", () => {
  assert.equal(rowGlyph(acct([modelQuota({ usedPercent: 20 })]), 80, 100), "ok");
  assert.equal(rowGlyph(acct([modelQuota({ usedPercent: 85 })]), 80, 100), "warn");
  assert.equal(rowGlyph(acct([modelQuota({ usedPercent: 100 })]), 80, 100), "crit");
});

test("no Gemini data: one neutral line, never a warning", () => {
  const notice = geminiNotice("agy", oldPayload());
  assert.deepEqual(notice, { text: "Gemini: not available", tone: "muted" });
  assert.equal(geminiNotice("agy", withModel()), null);
  assert.equal(geminiNotice("agy", nullPercent()), null, "a model-quota row with an unknown percent is Gemini data, shown as —");
  assert.equal(geminiNotice("agy", acct([w("gemini:5h")])), null);
  assert.equal(geminiNotice("claude", acct([w("five_hour")])), null);
  assert.deepEqual(geminiNotice("agy", acct([])), notice);
  assert.equal(shortWarning("agy", "partial-groups", ["x"]), null, "the amber Google warning is gone");
  assert.equal(shortWarning("agy", null, []), null);
});

test("footer: label 'Gemini', no duration, spoken label, saved selections keep working", () => {
  const model = windowSchema.parse(modelQuota());
  assert.equal(footerLabel("agy", model, false), "Gemini");
  assert.equal(footerLabel("agy", model, true), "Gemini");
  const cell = footerCell({ provider: "agy", windowId: "gemini:unknown", account: withModel(), window: model }, { warning: 80, danger: 100, offline: false, narrow: false, now: 1000 });
  assert.deepEqual([cell.label, cell.percent, cell.kind], ["Gemini", "35%", "value"]);
  assert.equal(footerSpeech("agy", cell), "agy Gemini model quota, 35 percent used");
  const none = footerCell({ provider: "agy", windowId: "gemini:unknown", account: withModel(), window: windowSchema.parse(modelQuota({ usedPercent: null })) }, { warning: 80, danger: 100, offline: false, narrow: false, now: 1000 });
  assert.deepEqual([none.percent, none.kind], ["—", "unknown"]);
  // an old saved selection of the 5h Gemini window on a model-quota-only account stays an unknown cell, no crash
  const saved = chooseItems(statusSchema.parse({ cacheOnly: true, generatedAt: 1, providers: [{ provider: "agy", cacheStatus: "available", accounts: [withModel()] }] }), [{ provider: "agy", windowId: "gemini:5h" }]);
  const old = footerCell(saved[0]!, { warning: 80, danger: 100, offline: false, narrow: false, now: 1000 });
  assert.deepEqual([old.kind, old.percent, old.label], ["unknown", "—", "Gemini 5h"]);
});

test("window type exports", () => {
  const typed: Window = windowSchema.parse(modelQuota());
  assert.equal(typed.id, "gemini:unknown");
});
