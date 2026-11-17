import test from "node:test";
import assert from "node:assert/strict";
import { statusSchema, displaySchema, type Window, type Account } from "../shared/contracts.js";
import { status } from "./fixtures.js";
import {
  footerGrid,
  footerCell,
  footerLabel,
  footerSummary,
  footerSpeech,
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
  accountDetail,
  toggleOpenAccount,
  pruneOpenAccounts,
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
  // an automatic agy handoff that is renewing candidates shows what it is doing, not a switch to an unknown account
  assert.equal(handoffRow(handoff({ provider: "agy", trigger: "automaticSwitch", phase: "switching", target: null, targetAlias: null }))!.text, "Renewing agy accounts and switching…");
  assert.equal(handoffRow(handoff({ provider: "agy", trigger: "automaticSwitch", phase: "waiting", target: null, targetAlias: null, waitingFor: 2 }))!.text, "Renewing agy accounts when idle · 2 agents working");
  assert.equal(handoffRow(handoff({ provider: "agy", trigger: "automaticSwitch", phase: "switching", target: "22222222-2222-4222-8222-222222222222", targetAlias: "Solo" }))!.text, "Switching (Solo)", "a known target keeps the switch wording");
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

// 0.9.7: other accounts expand into the same detail block the active account shows.
const NOW = 1_800_000_000;
const inactive = (patch: Partial<Account> = {}) => acct({
  id: "inactive-1", alias: "Pro", email: "tobias@example.test", plan: "Pro", active: false, loginExpiresAt: null, usageStatus: "ok",
  windows: [
    win("codex:primary_window", { label: "5-hour", usedPercent: 40, resetsAt: NOW + 3600, fetchedAt: NOW - 600 }),
    win("codex:secondary_window", { label: "Weekly", usedPercent: 100, resetsAt: NOW + 86400, fetchedAt: NOW - 90000, stale: true }),
  ],
  resetCreditsAvailable: 2,
  paidUsage: { kind: "credits", fetchedAt: NOW - 60, stale: false, hasCredits: true, balance: "12.50" },
  ...patch,
});
test("account detail: identity, every window, read time, login, credits, banked resets and health for an inactive account", () => {
  const d = accountDetail("codex", inactive({ usageStatus: "needs-renewal", health: "attention", attentionSince: NOW - 7200 }), { warning: 80, danger: 100, offline: false, now: NOW });
  assert.equal(d.identity, "tobias@example.test · Pro");
  assert.deepEqual(d.windows.map((w) => w.id), ["codex:primary_window", "codex:secondary_window"]);
  assert.equal(d.readAt, NOW - 600);
  assert.match(d.loginText, /login has no fixed end date/);
  assert.equal(d.badge?.text, "Login check failed");
  assert.match(d.attention ?? "", /Login check failed · first seen/);
  assert.ok(d.paid.some((l) => /Banked resets: 2/.test(l.text)));
  assert.ok(d.paid.length >= 2, "credits and banked resets");
  assert.equal(d.usageUnknown, false);
});
test("account detail: no windows says usage is unknown; unknown identity is spelled out; the same builder serves active and inactive", () => {
  const d = accountDetail("claude", inactive({ email: null, plan: null, windows: [], paidUsage: undefined, resetCreditsAvailable: undefined }), { warning: 80, danger: 100, offline: false, now: NOW });
  assert.equal(d.identity, "Email unknown · Plan unknown");
  assert.equal(d.usageUnknown, true);
  const a = accountDetail("codex", inactive({ active: true }), { warning: 80, danger: 100, offline: false, now: NOW });
  const b = accountDetail("codex", inactive(), { warning: 80, danger: 100, offline: false, now: NOW });
  assert.deepEqual({ ...a, badge: undefined }, { ...b, badge: undefined });
});
test("O-L3: an inactive agy account shows its own login state, not 'login renewed by agy'", () => {
  const o = { warning: 80, danger: 100, offline: false, now: NOW };
  assert.equal(accountDetail("agy", inactive({ active: true }), o).loginText, "login renewed by agy");
  assert.equal(accountDetail("agy", inactive({ usageStatus: "needs-renewal" }), o).loginText, "needs renewal");
  assert.match(accountDetail("agy", inactive({ loginExpiresAt: NOW + 3600 }), o).loginText, /^access token valid until /);
  assert.equal(accountDetail("agy", inactive({ loginExpiresAt: NOW - 60 }), o).loginText, "needs renewal", "an expired access token needs renewal");
  assert.equal(accountDetail("agy", inactive(), o).loginText, "renewed when SubBaton switches to it");
  assert.equal(accountDetail("codex", inactive(), o).loginText, "login has no fixed end date", "other providers are unchanged");
});
test("several other accounts can be open at once and the open state survives a status refresh", () => {
  let open: string[] = [];
  open = toggleOpenAccount(open, "a");
  open = toggleOpenAccount(open, "b");
  assert.deepEqual(open, ["a", "b"]);
  // a refresh brings the same accounts again: nothing closes
  assert.deepEqual(pruneOpenAccounts(open, [acct({ id: "a" }), acct({ id: "b" }), acct({ id: "c" })]), ["a", "b"]);
  // an account that disappeared is forgotten, the others stay open
  assert.deepEqual(pruneOpenAccounts(open, [acct({ id: "b" })]), ["b"]);
  assert.deepEqual(toggleOpenAccount(open, "a"), ["b"]);
  assert.deepEqual(toggleOpenAccount([], "a"), ["a"], "collapsed by default");
});

// 0.9.8: an exhausted window on an account that keeps working on paid usage is "Using credits", not "Exhausted".
const exhausted = [win("five_hour", { usedPercent: 40 }), win("seven_day", { usedPercent: 100, resetsAt: 4_000_000_000 })];
const credits = (patch: Record<string, unknown> = {}) => ({ kind: "credits" as const, fetchedAt: 1, stale: false, hasCredits: true, balance: "70612", ...patch });
const extra = (patch: Record<string, unknown> = {}) => ({ kind: "extraUsage" as const, fetchedAt: 1, stale: false, enabled: true, utilization: 20, monthlyLimit: 500, usedCredits: 100, ...patch });
const badgeOf = (a: Partial<Account>) => accountBadge(acct({ windows: exhausted, ...a }), 80, 100, 1_000);
test("badge: an exhausted Codex account on credits says Using credits (active) or Exhausted, credits left (inactive), as a warning", () => {
  assert.deepEqual(badgeOf({ active: true, paidUsage: credits() }), { text: "Using credits", tone: "warning" });
  assert.deepEqual(badgeOf({ active: false, paidUsage: credits() }), { text: "Exhausted, credits left", tone: "warning" });
  assert.deepEqual(badgeOf({ active: true, paidUsage: credits({ hasCredits: undefined, unlimited: true, balance: undefined }) }), { text: "Using credits", tone: "warning" });
});
test("badge: an exhausted Claude account with extra usage on says Using extra usage / Exhausted, extra usage on", () => {
  assert.deepEqual(badgeOf({ active: true, paidUsage: extra() }), { text: "Using extra usage", tone: "warning" });
  assert.deepEqual(badgeOf({ active: false, paidUsage: extra() }), { text: "Exhausted, extra usage on", tone: "warning" });
});
test("badge: a stale paid reading still gives the label; no credits, no paid reading or extra usage off stay Exhausted (danger)", () => {
  assert.equal(badgeOf({ active: true, paidUsage: credits({ stale: true, fetchedAt: 0 }) })?.text, "Using credits");
  assert.equal(badgeOf({ active: true, paidUsage: extra({ stale: true }) })?.text, "Using extra usage");
  for (const paidUsage of [undefined, credits({ hasCredits: false, balance: "0" }), credits({ hasCredits: false }), credits({ balance: "0", hasCredits: true }), extra({ enabled: false }), extra({ utilization: 100 }), extra({ usedCredits: 500 }), extra({ monthlyLimit: 0 })])
    assert.deepEqual(badgeOf({ active: true, paidUsage }), { text: "Exhausted", tone: "danger" }, JSON.stringify(paidUsage));
});
test("badge: health and renewal precedence stays above the credits label; windows below 100 are unchanged", () => {
  assert.equal(badgeOf({ health: "needsLogin", paidUsage: credits() })?.text, "Needs login");
  assert.equal(badgeOf({ health: "quarantined", paidUsage: credits() })?.text, "Quarantined");
  assert.equal(badgeOf({ enabled: false, paidUsage: credits() })?.text, "Disabled");
  assert.equal(badgeOf({ usageStatus: "needs-renewal", paidUsage: credits() })?.text, "Needs renewal");
  assert.equal(badgeOf({ windows: [win("five_hour", { usedPercent: 40 })], paidUsage: credits() })?.text, "Active");
});
test("glyph: an account running on credits is a warning, not critical; without credits it stays critical", () => {
  assert.equal(rowGlyph(acct({ windows: exhausted, paidUsage: credits() }), 80, 100), "warn");
  assert.equal(rowGlyph(acct({ windows: exhausted, paidUsage: extra() }), 80, 100), "warn");
  assert.equal(rowGlyph(acct({ windows: exhausted }), 80, 100), "crit");
  assert.equal(rowGlyph(acct({ windows: exhausted, health: "needsLogin", paidUsage: credits() }), 80, 100), "crit");
});
test("footer: the 100 % cell stays red but its spoken text says the account runs on credits", () => {
  const item = (account: Account) => ({ provider: "codex" as const, windowId: "seven_day", window: account.windows[1]!, account });
  const opts = { warning: 80, danger: 100, offline: false, narrow: false, now: 1_000 };
  const on = footerCell(item(acct({ windows: exhausted, paidUsage: credits() })), opts);
  assert.equal(on.tone, "danger");
  assert.equal(on.percent, "100%");
  assert.match(footerSpeech("codex", on), /100 percent used, exhausted, running on credits/);
  const claude = footerCell({ ...item(acct({ windows: exhausted, paidUsage: extra() })), provider: "claude" as const }, opts);
  assert.match(footerSpeech("claude", claude), /exhausted, running on extra usage/);
  const none = footerCell(item(acct({ windows: exhausted })), opts);
  assert.equal(footerSpeech("codex", none), "Codex Weekly, 100 percent used, exhausted".replace("Weekly", none.spoken.replace(/^Codex /, "")));
  assert.doesNotMatch(footerSpeech("codex", none), /running on/);
});
