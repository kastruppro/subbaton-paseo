import test from "node:test";
import assert from "node:assert/strict";
import { statusSchema, displaySchema, type Window, type Account } from "../shared/contracts.js";
import { status } from "./fixtures.js";
import {
  footerGrid,
  footerCell,
  footerLabel,
  footerSummary,
} from "../client/footer-model.js";
import {
  windowLabel,
  miniWindows,
  accountBadge,
  canSwitch,
  rowGlyph,
  otherAccountSummary,
  idleExplanation,
  handoffRow,
  providerLine,
  autoLines,
  switchChoices,
  bestPreviewLine,
  showBestSwitch,
  expandedSections,
} from "../client/popover-model.js";

const win = (id: string, patch: Partial<Window> = {}): Window => ({
  id, label: id, usedPercent: 10, resetsAt: 100000, fetchedAt: 1,
  stale: false, inferred: false, ...patch,
});
const acct = (patch: Partial<Account> = {}): Account => ({
  id: "a", alias: "Work", email: null, active: true, enabled: true, health: "ok",
  plan: null, loginExpiresAt: null, usageStatus: "ok", windows: [], ...patch,
});

test("status parsing: auto and daemonRestartPending present, absent and null", () => {
  const base = structuredClone(status) as any;
  const absent = statusSchema.parse(base).providers[0] as any;
  assert.equal(absent.auto, undefined);
  assert.equal(absent.daemonRestartPending, undefined);
  base.providers[0].auto = { enabled: true, paused: true, pauseReason: "flapping", pauseId: "p1", message: "m", lastAutomaticSwitchAt: 5 };
  base.providers[0].daemonRestartPending = true;
  base.providers[0].daemonRestartPendingSince = 7;
  const present = statusSchema.parse(base).providers[0] as any;
  assert.equal(present.auto.paused, true);
  assert.equal(present.auto.pauseReason, "flapping");
  assert.equal(present.daemonRestartPending, true);
  assert.equal(present.daemonRestartPendingSince, 7);
  base.providers[0].auto = null;
  base.providers[0].daemonRestartPending = null;
  delete base.providers[0].daemonRestartPendingSince;
  const nulls = statusSchema.parse(base).providers[0] as any;
  assert.equal(nulls.auto ?? undefined, undefined);
  assert.equal(nulls.daemonRestartPending ?? undefined, undefined);
  base.providers[0].auto = { enabled: "yes" };
  base.providers[0].daemonRestartPending = "maybe";
  const bad = statusSchema.parse(base).providers[0] as any;
  assert.equal(bad.auto ?? undefined, undefined);
  assert.equal(bad.daemonRestartPending ?? undefined, undefined);
});

test("display defaults are Claude 5h, Codex 5h, agy Gemini 5h; at most 6 items", () => {
  const d = displaySchema.parse({});
  assert.deepEqual(d.items.map((i) => `${i.provider}:${i.windowId}`), [
    "claude:five_hour", "codex:codex:primary_window", "agy:gemini:5h",
  ]);
  const many = Array.from({ length: 9 }, (_, i) => ({ provider: "claude", windowId: `w${i}` }));
  assert.equal(displaySchema.parse({ items: many }).items.length, 6);
});

test("footer grid: 3 columns, 1-3 items one row, 4-6 two rows, no overflow", () => {
  assert.deepEqual(footerGrid(0), { count: 0, rows: 0, columns: 3 });
  assert.deepEqual(footerGrid(1), { count: 1, rows: 1, columns: 3 });
  assert.deepEqual(footerGrid(3), { count: 3, rows: 1, columns: 3 });
  assert.deepEqual(footerGrid(4), { count: 4, rows: 2, columns: 3 });
  assert.deepEqual(footerGrid(6), { count: 6, rows: 2, columns: 3 });
  assert.equal(footerGrid(9).count, 6);
});

test("footer labels: short, agy groups shortened when narrow", () => {
  assert.equal(footerLabel("claude", win("five_hour"), false), "5h");
  assert.equal(footerLabel("claude", win("seven_day"), false), "7d");
  assert.equal(footerLabel("codex", win("codex:primary_window", { windowSeconds: 18000 }), false), "5h");
  assert.equal(footerLabel("codex", win("codex:secondary_window"), false), "7d");
  assert.equal(footerLabel("agy", win("gemini:5h"), false), "Gemini 5h");
  assert.equal(footerLabel("agy", win("gemini:5h"), true), "G 5h");
  assert.equal(footerLabel("agy", win("claude-gpt:5h"), false), "C/GPT 5h");
  assert.equal(footerLabel("agy", win("claude-gpt:5h"), true), "CG 5h");
});

const cell = (account: Account | null, window: Window | null, offline = false) =>
  footerCell({ provider: "claude", windowId: "five_hour", account, window }, { warning: 80, danger: 100, offline, narrow: false, now: 50 });

test("footer cell states", () => {
  const ok = cell(acct(), win("five_hour", { usedPercent: 4 }));
  assert.equal(ok.kind, "value"); assert.equal(ok.percent, "4%"); assert.equal(ok.tone, "normal"); assert.equal(ok.fill, 4);
  const near = cell(acct(), win("five_hour", { usedPercent: 85 }));
  assert.equal(near.tone, "warning");
  const stale = cell(acct(), win("five_hour", { usedPercent: 62, stale: true }));
  assert.equal(stale.kind, "stale"); assert.equal(stale.percent, "~62%"); assert.equal(stale.clock, true);
  assert.equal(cell(acct(), win("five_hour", { usedPercent: 62 }), true).percent, "~62%");
  const unknown = cell(acct(), win("five_hour", { usedPercent: null }));
  assert.equal(unknown.kind, "unknown"); assert.equal(unknown.percent, "—"); assert.equal(unknown.fill, 0);
  assert.equal(cell(null, null).kind, "unknown");
  assert.equal(cell(acct(), win("five_hour", { usedPercent: 100 })).kind, "blocked");
  assert.equal(cell(acct({ health: "needsLogin" }), win("five_hour", { usedPercent: 3 })).kind, "blocked");
  assert.equal(cell(acct({ health: "quarantined" }), null).kind, "blocked");
  assert.equal(cell(acct({ health: "attention" }), win("five_hour", { usedPercent: 3 })).kind, "value");
  const passed = cell(acct(), win("five_hour", { usedPercent: 99, resetsAt: 10 }));
  assert.equal(passed.kind, "unknown");
  assert.equal(cell(acct(), win("five_hour", { usedPercent: 0, inferred: true })).percent, "≈0%");
});

test("footer summary: unavailable, nothing selected, grid", () => {
  assert.equal(footerSummary({ settingsReady: true, itemCount: 0, offline: true }), "unavailable");
  assert.equal(footerSummary({ settingsReady: true, itemCount: 0, offline: false }), "none");
  assert.equal(footerSummary({ settingsReady: true, itemCount: 3, offline: true }), "unavailable");
  assert.equal(footerSummary({ settingsReady: true, itemCount: 3, offline: false }), "grid");
  assert.equal(footerSummary({ settingsReady: false, itemCount: 0, offline: false }), "loading");
});

test("window labels use the shared wording", () => {
  assert.equal(windowLabel("claude", win("five_hour")), "5h");
  assert.equal(windowLabel("claude", win("seven_day")), "7d");
  assert.equal(windowLabel("claude", win("seven_day_opus")), "Opus 7d");
  assert.equal(windowLabel("claude", win("weekly_scoped:Fable")), "Fable 7d");
  assert.equal(windowLabel("agy", win("gemini:5h")), "Gemini 5h");
  assert.equal(windowLabel("agy", win("claude-gpt:weekly")), "C/GPT 7d");
  assert.equal(windowLabel("codex", win("codex:secondary_window", { windowSeconds: 604800 })), "7d");
});

test("collapsed row shows 5h + 7d, agy its two 5h groups", () => {
  const claude = [win("weekly_scoped:Fable"), win("seven_day"), win("five_hour")];
  assert.deepEqual(miniWindows("claude", claude).map((w) => w.id), ["five_hour", "seven_day"]);
  const codex = [win("codex:secondary_window"), win("codex:primary_window")];
  assert.deepEqual(miniWindows("codex", codex).map((w) => w.id), ["codex:primary_window", "codex:secondary_window"]);
  const agy = [win("claude-gpt:5h"), win("gemini:weekly"), win("gemini:5h")];
  assert.deepEqual(miniWindows("agy", agy).map((w) => w.id), ["gemini:5h", "claude-gpt:5h"]);
});

test("account badges use the shared wording", () => {
  const b = (patch: Partial<Account>, w = 80) => accountBadge(acct(patch), w, 100)?.text;
  assert.equal(b({ active: true }), "Active");
  assert.equal(b({ active: false, health: "needsLogin" }), "Needs login");
  assert.equal(b({ active: false, health: "quarantined" }), "Quarantined");
  assert.equal(b({ active: false, health: "deviceBlocked" }), "Device blocked");
  assert.equal(b({ active: false, health: "attention" }), "Login check failed");
  assert.equal(b({ active: false, enabled: false }), "Disabled");
  assert.equal(b({ active: false, windows: [win("five_hour", { usedPercent: 100, resetsAt: null })] }), "Exhausted");
  assert.equal(b({ active: false, windows: [win("five_hour", { usedPercent: 92, resetsAt: null })] }), "Near limit");
  assert.equal(b({ active: false, windows: [win("five_hour", { usedPercent: 12 })] }), undefined);
});

test("manual switch to an attention account is allowed without extra warning", () => {
  assert.equal(canSwitch(acct({ active: false, health: "attention" })), true);
  assert.equal(canSwitch(acct({ active: false, health: "quarantined" })), false);
  assert.equal(canSwitch(acct({ active: false, health: "deviceBlocked" })), false);
  assert.equal(canSwitch(acct({ active: false, health: "needsLogin" })), false);
  assert.equal(canSwitch(acct({ active: false, enabled: false })), false);
  assert.equal(canSwitch(acct({ active: true })), false);
});

test("row glyph rates the worst window", () => {
  assert.equal(rowGlyph(undefined, 80, 100), "mute");
  assert.equal(rowGlyph(acct({ windows: [win("five_hour", { usedPercent: 4 })] }), 80, 100), "ok");
  assert.equal(rowGlyph(acct({ windows: [win("five_hour", { usedPercent: 4 }), win("gemini:5h", { usedPercent: 85 })] }), 80, 100), "warn");
  assert.equal(rowGlyph(acct({ health: "needsLogin" }), 80, 100), "crit");
});

test("other account line shows worst windows", () => {
  const a = acct({ active: false, windows: [win("five_hour", { usedPercent: 92, resetsAt: null }), win("seven_day", { usedPercent: 77, resetsAt: null })] });
  assert.equal(otherAccountSummary("claude", a), "5h 92% · 7d 77%");
  assert.equal(otherAccountSummary("claude", acct({ windows: [] })), "");
});

test("idle wording is one sentence; claude has no idle choice", () => {
  assert.equal(idleExplanation("codex", true), "Waits until no Paseo Codex agent is working, then switches and restarts the daemon.");
  assert.equal(idleExplanation("codex", false), "Switches now, reloads the Codex agents that are not working at once and the others as soon as they are idle.");
  assert.equal(idleExplanation("agy", false), "Waits until no Paseo agy agent is working, then closes them, switches and reopens them.");
  assert.deepEqual(switchChoices("claude"), ["now"]);
  assert.deepEqual(switchChoices("codex"), ["now", "idle"]);
  assert.deepEqual(switchChoices("agy"), ["now", "idle"]);
});

const handoff = (patch: any = {}) => ({
  id: "h", provider: "codex", target: null, targetAlias: "Solo", trigger: "manual", restartDaemon: false,
  phase: "waiting", requestedAt: 1, deadline: 2, updatedAt: 1, waitingFor: 2, code: null, message: "m",
  affected: ["x", "y"], reopened: [], failedReopen: [], daemonOutcome: null, ...patch,
});
test("handoff rows: pending with Cancel, uncertain with Details", () => {
  const w = handoffRow(handoff())!;
  assert.equal(w.text, "Switching to Solo when idle · 2 agents working");
  assert.equal(w.action, "cancel"); assert.equal(w.tone, "warning");
  assert.equal(handoffRow(handoff({ waitingFor: 1 }))!.text, "Switching to Solo when idle · 1 agent working");
  const u = handoffRow(handoff({ provider: "agy", targetAlias: "Backup", phase: "uncertain" }))!;
  assert.equal(u.text, "Switch to Backup uncertain – check the agy login");
  assert.equal(u.action, "details"); assert.equal(u.tone, "danger");
  assert.equal(handoffRow(handoff({ phase: "uncertain", provider: "codex" }))!.text, "Switch to Solo uncertain – check the Codex login");
  assert.equal(handoffRow(handoff({ phase: "done" })), null);
  assert.equal(handoffRow(null), null);
});

test("error and loading take one line with switching disabled", () => {
  const err = providerLine({ queryError: "SubBaton is busy.", pending: false, hasData: false, provider: undefined })!;
  assert.equal(err.text, "Status unreadable: SubBaton is busy."); assert.equal(err.kind, "error"); assert.equal(err.disableSwitching, true);
  const load = providerLine({ queryError: null, pending: true, hasData: false, provider: undefined })!;
  assert.equal(load.text, "Loading cached status…"); assert.equal(load.kind, "loading");
  const missing = providerLine({ queryError: null, pending: false, hasData: true, provider: { cacheStatus: "missing", accounts: [] } as any })!;
  assert.equal(missing.kind, "error"); assert.ok(!/snapshot/i.test(missing.text));
  const unreadable = providerLine({ queryError: null, pending: false, hasData: true, provider: { cacheStatus: "unavailable", accounts: [] } as any })!;
  assert.equal(unreadable.disableSwitching, true);
  assert.equal(providerLine({ queryError: null, pending: false, hasData: true, provider: { cacheStatus: "available", accounts: [acct()] } as any }), null);
  const none = providerLine({ queryError: null, pending: false, hasData: true, provider: { cacheStatus: "available", accounts: [] } as any })!;
  assert.equal(none.text, "No accounts yet");
});

test("paused and restart pending only appear when the CLI reports them", () => {
  assert.deepEqual(autoLines("codex", {} as any), []);
  assert.deepEqual(autoLines("codex", { auto: { enabled: true, paused: false }, daemonRestartPending: false } as any), []);
  assert.deepEqual(autoLines("codex", { daemonRestartPending: null } as any), []);
  const lines = autoLines("codex", { auto: { enabled: true, paused: true, pauseReason: "flapping" }, daemonRestartPending: true } as any);
  assert.deepEqual(lines.map((l) => l.text), ["Automatic switching paused (flapping)", "Restart pending, waits for idle"]);
  assert.deepEqual(autoLines("claude", { auto: { enabled: true, paused: true }, daemonRestartPending: true } as any).map((l) => l.text), ["Automatic switching paused"]);
});

test("best preview wording and availability", () => {
  assert.equal(showBestSwitch("claude", 2), true);
  assert.equal(showBestSwitch("codex", 2), true);
  assert.equal(showBestSwitch("agy", 0), false);
  assert.equal(bestPreviewLine({ outcome: "unchanged", alias: "Team", message: "" })?.text, "Team is already the best account.");
  assert.equal(bestPreviewLine({ outcome: "unchanged", message: "" })?.text, "The active account is already the best.");
  assert.equal(bestPreviewLine({ outcome: "none", message: "" })?.text, "No account is eligible right now.");
  assert.equal(bestPreviewLine({ outcome: "error", message: "Busy." })?.text, "Busy.");
  assert.equal(bestPreviewLine({ outcome: "target", message: "" }), null);
});

test("PC1: expanded row lists every saved account even with no active account", () => {
  const a = acct({ id: "a", alias: "One", active: false });
  const b = acct({ id: "b", alias: "Two", active: false, health: "quarantined" });
  const none = expandedSections("codex", [a, b], false);
  assert.equal(none.activeDetails, false);
  assert.equal(none.noActiveNote, "No active account. Choose one to switch to.");
  assert.deepEqual(none.others.map((x) => x.id), ["a", "b"]);
  assert.equal(none.best, true);
  const withActive = expandedSections("codex", [acct({ id: "c", active: true }), a], false);
  assert.equal(withActive.activeDetails, true);
  assert.equal(withActive.noActiveNote, null);
  assert.deepEqual(withActive.others.map((x) => x.id), ["a"]);
  assert.equal(expandedSections("claude", [acct({ active: true })], false).best, false);
  const locked = expandedSections("codex", [a], true);
  assert.equal(locked.others.length, 0);
  assert.equal(locked.best, false);
  assert.equal(expandedSections("codex", [], false).noActiveNote, null);
});

test("PC2: other-account summary marks stale, passed-reset and estimated readings", () => {
  const sum = (windows: Window[], offline = false) =>
    otherAccountSummary("claude", acct({ active: false, windows }), { now: 50, offline });
  assert.equal(sum([win("five_hour", { usedPercent: 92, resetsAt: 1000, stale: true })]), "5h ~92%");
  assert.equal(sum([win("five_hour", { usedPercent: 92, resetsAt: 1000 })], true), "5h ~92%");
  assert.equal(sum([win("five_hour", { usedPercent: 92, resetsAt: 10 })]), "5h —");
  assert.equal(sum([win("five_hour", { usedPercent: 0, resetsAt: 10, inferred: true })]), "5h ≈0%");
  assert.equal(
    sum([win("five_hour", { usedPercent: 92, resetsAt: 1000 }), win("seven_day", { usedPercent: 77, resetsAt: 10 })]),
    "5h 92% · 7d —",
  );
});
