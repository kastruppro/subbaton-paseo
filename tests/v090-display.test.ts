import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { statusSchema, accountSchema, displaySchema, type Account } from "../shared/contracts.js";
import { paidUsageLines, attentionLine } from "../client/paid-model.js";
import { footerCell } from "../client/footer-model.js";
import { groupFor, isCreditsFallback, creditsFallbackTitle, creditsFallbackHelp, setDraft, draftChanges } from "../client/settings-model.js";

const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures-v090/${name}`, import.meta.url), "utf8"));
const accounts = read("accounts.json") as Record<string, unknown>;
const parse = (name: string): Account => accountSchema.parse(accounts[name]);
const NOW = 1800000100;

test("older status JSON without any 0.9.0 field still parses", () => {
  const a = parse("missing");
  assert.equal(a.paidUsage, undefined);
  assert.equal(a.attentionSince, undefined);
  assert.equal(a.resetCreditsAvailable, undefined);
  assert.deepEqual(paidUsageLines("codex", a, NOW), []);
  assert.equal(attentionLine(a, NOW), null);
});

test("frozen status fixture parses with paid usage, resets and restart pending", () => {
  const fixture = read("status.json").result;
  const s = statusSchema.parse(fixture);
  const claude = s.providers[0]!.accounts[0]!, codex = s.providers[1]!.accounts[0]!;
  assert.equal(claude.paidUsage?.kind, "extraUsage");
  assert.equal(codex.paidUsage?.balance, "12.50");
  assert.equal(codex.resetCreditsAvailable, 2);
  assert.equal(s.providers[1]!.daemonRestartPending, true);
});

test("malformed paid fields are dropped, numeric balances normalised, bad kinds ignored", () => {
  const base = { ...(accounts.missing as object) };
  const parsed = accountSchema.parse({ ...base, paidUsage: { kind: "credits", fetchedAt: 1, stale: false, balance: 12.5, hasCredits: "yes", approxLocalMessages: -3 }, resetCreditsAvailable: -1, attentionSince: "soon" });
  assert.equal(parsed.paidUsage?.balance, "12.5");
  assert.equal(parsed.paidUsage?.hasCredits, undefined);
  assert.equal(parsed.paidUsage?.approxLocalMessages, undefined);
  assert.equal(parsed.resetCreditsAvailable, undefined);
  assert.equal(parsed.attentionSince, undefined);
  assert.equal(accountSchema.parse({ ...base, paidUsage: { kind: "wallet", fetchedAt: 1, stale: false } }).paidUsage, undefined);
});

test("Codex credits are shown in credits, estimates as estimates, resets separately", () => {
  const codex = statusSchema.parse(read("status.json").result).providers[1]!.accounts[0]!;
  const lines = paidUsageLines("codex", codex, NOW);
  assert.deepEqual(lines.map((l) => l.text), [
    "Credits: 12.5 credits · estimate: about 24 local or 4 cloud messages",
    "Banked resets: 2",
  ]);
  assert.equal(lines[0]!.stale, false);
});

test("zero, unlimited, partial and stale Codex credits", () => {
  assert.equal(paidUsageLines("codex", parse("zero"), NOW)[0]!.text, "Credits: none (0 credits)");
  assert.equal(paidUsageLines("codex", parse("unlimited"), NOW)[0]!.text, "Credits: unlimited");
  assert.equal(paidUsageLines("codex", parse("partial"), NOW)[0]!.text, "Credits: unknown");
  const stale = paidUsageLines("codex", parse("stale"), NOW)[0]!;
  assert.equal(stale.text, "Credits (stale): ~12.5 credits");
  assert.equal(stale.stale, true);
  // fresh flag but older than 180 s counts as stale
  const old = accountSchema.parse({ ...(accounts.missing as object), paidUsage: { kind: "credits", fetchedAt: NOW - 181, stale: false, hasCredits: true, balance: "3" } });
  assert.equal(paidUsageLines("codex", old, NOW)[0]!.stale, true);
});

test("Claude extra usage: funds unknown, units unknown, a missing cap is not unlimited", () => {
  const claude = statusSchema.parse(read("status.json").result).providers[0]!.accounts[0]!;
  assert.deepEqual(paidUsageLines("claude", claude, NOW).map((l) => l.text), [
    "Extra usage enabled; funds unknown",
    "Used 120 of 500 monthly cap (units unknown)",
  ]);
  const noCap = paidUsageLines("claude", parse("claude-unknown-cap"), NOW).map((l) => l.text);
  assert.deepEqual(noCap, ["Extra usage enabled; funds unknown", "Used 120 (units unknown); monthly cap unknown"]);
  assert.ok(!noCap.join(" ").toLowerCase().includes("unlimited"));
  assert.ok(!noCap.join(" ").toLowerCase().includes("balance"));
});

test("attention age comes only from the CLI", () => {
  assert.equal(attentionLine(parse("attention"), NOW)?.text, "Login check failed · first seen 2 h 48 min ago");
  assert.equal(attentionLine(parse("missing"), NOW), null);
});

const cell = (provider: "claude" | "codex", account: Account | null, narrow = false) =>
  footerCell({ provider, windowId: "paid", account, window: null }, { warning: 80, danger: 100, offline: false, narrow, now: NOW });
test("Credits footer item states", () => {
  const codex = statusSchema.parse(read("status.json").result).providers[1]!.accounts[0]!;
  const claude = statusSchema.parse(read("status.json").result).providers[0]!.accounts[0]!;
  const c = cell("codex", codex);
  assert.deepEqual([c.label, c.percent, c.meter, c.kind], ["Credits", "12.5", false, "value"]);
  assert.equal(cell("codex", codex, true).label, "Cr");
  assert.equal(cell("claude", claude).percent, "On");
  assert.equal(cell("claude", claude).label, "Extra");
  assert.equal(cell("codex", parse("unlimited")).percent, "∞");
  assert.equal(cell("codex", parse("zero")).percent, "0");
  const stale = cell("codex", parse("stale"));
  assert.deepEqual([stale.kind, stale.percent, stale.clock], ["stale", "~12.5", true]);
  assert.deepEqual([cell("codex", parse("partial")).kind, cell("codex", parse("partial")).percent], ["unknown", "—"]);
  assert.equal(cell("codex", null).kind, "unknown");
  assert.equal(cell("claude", parse("claude-unknown-cap")).percent, "On");
});

test("footer selection persistence keeps the Credits item", () => {
  const d = displaySchema.parse({ items: [{ provider: "codex", windowId: "paid" }, { provider: "claude", windowId: "five_hour" }] });
  assert.deepEqual(displaySchema.parse(JSON.parse(JSON.stringify(d))).items[0], { provider: "codex", windowId: "paid" });
});

test("Credits fallback setting: label, help, group and boolean round trip", () => {
  assert.equal(groupFor("creditsFallback"), "Other settings", "only the CLI path auto.creditsFallback is recognised");
  assert.equal(isCreditsFallback("auto.creditsFallback"), true);
  assert.equal(isCreditsFallback("creditsFallback"), false);
  assert.equal(groupFor("auto.creditsFallback"), "Automatic switching");
  assert.equal(creditsFallbackTitle(true), "Credits fallback: On");
  assert.equal(creditsFallbackTitle(false), "Credits fallback: Off");
  assert.match(creditsFallbackHelp(), /official CLI may automatically consume paid usage/);
  const section = {} as never;
  let draft = setDraft({}, section, ["auto", "creditsFallback"], false, true);
  assert.deepEqual(draftChanges(draft), [{ path: ["auto", "creditsFallback"], value: false }]);
  draft = setDraft(draft, section, ["auto", "creditsFallback"], true, true);
  assert.deepEqual(draftChanges(draft), []);
});
