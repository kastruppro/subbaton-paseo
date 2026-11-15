import test from "node:test";
import assert from "node:assert/strict";
import { formatCredits, formatCreditsWhole } from "../client/credits-format.js";
import { paidUsageLines, paidFooterValue } from "../client/paid-model.js";
import { footerCell, footerSpeech } from "../client/footer-model.js";
import { accountSchema } from "../shared/contracts.js";

test("balances are rounded to two decimals, trailing zeros dropped, grouped with commas", () => {
  const cases: [string, string][] = [
    ["71023.5086225000", "71,023.51"],
    ["0", "0"],
    ["0.00", "0"],
    ["12.50", "12.5"],
    ["12.5", "12.5"],
    ["1000", "1,000"],
    ["1234567.891", "1,234,567.89"],
    ["999999.999", "1,000,000"],
    ["0.005", "0.01"],
    ["0.0049999", "0"],
    ["0.994", "0.99"],
    ["0.995", "1"],
    ["007.10", "7.1"],
    [".5", "0.5"],
    ["5.", "5"],
    ["+5", "5"],
    ["-1234.5", "-1,234.5"],
    ["-0.001", "0"],
    ["-0.005", "-0.01"],
    [" 42 ", "42"],
    ["123456789012345678901234567890.126", "123,456,789,012,345,678,901,234,567,890.13"],
  ];
  for (const [raw, expected] of cases) assert.equal(formatCredits(raw), expected, raw);
});

test("rounding is exact decimal arithmetic, not binary floating point", () => {
  // 1.005 and 2.675 are the classic float traps (they sit just below the half in binary).
  assert.equal(formatCredits("1.005"), "1.01");
  assert.equal(formatCredits("2.675"), "2.68");
  assert.equal(formatCredits("9007199254740993.015"), "9,007,199,254,740,993.02");
  assert.equal(formatCredits("0.1"), "0.1");
});

test("anything that is not a plain decimal falls back to the raw string", () => {
  for (const raw of ["1e3", "1E-2", "abc", "12,5", "1.2.3", "--4", "0x10", "NaN", "Infinity", "", "  ", "5 credits", "∞"])
    assert.equal(formatCredits(raw), raw, raw);
});

test("spoken form is whole credits, truncated not rounded", () => {
  assert.equal(formatCreditsWhole("71023.5086225000"), "71,023");
  assert.equal(formatCreditsWhole("0.99"), "0");
  assert.equal(formatCreditsWhole("12.50"), "12");
  assert.equal(formatCreditsWhole("-1234.9"), "-1,234");
  assert.equal(formatCreditsWhole("-0.9"), "0");
  assert.equal(formatCreditsWhole("1000"), "1,000");
  assert.equal(formatCreditsWhole("garbage"), "garbage");
});

const acct = (paid: Record<string, unknown>) =>
  accountSchema.parse({ id: "a", alias: "x", active: true, enabled: true, health: "ok", usageStatus: "ok", windows: [], paidUsage: paid });

test("account details show the rounded, grouped balance and keep the stale wording and ~", () => {
  const fresh = acct({ kind: "credits", fetchedAt: 100, stale: false, hasCredits: true, balance: "71023.5086225000" });
  assert.equal(paidUsageLines("codex", fresh, 120)[0]!.text, "Credits: 71,023.51 credits");
  const stale = acct({ kind: "credits", fetchedAt: 1, stale: true, hasCredits: true, balance: "71023.5086225000" });
  assert.equal(paidUsageLines("codex", stale, 120)[0]!.text, "Credits (stale): ~71,023.51 credits");
  const small = acct({ kind: "credits", fetchedAt: 100, stale: false, hasCredits: true, balance: "12.50", approxLocalMessages: 24 });
  assert.equal(paidUsageLines("codex", small, 120)[0]!.text, "Credits: 12.5 credits · estimate: about 24 local messages");
  const zero = acct({ kind: "credits", fetchedAt: 100, stale: false, hasCredits: false, balance: "0.00" });
  assert.equal(paidUsageLines("codex", zero, 120)[0]!.text, "Credits: none (0 credits)");
  const raw = acct({ kind: "credits", fetchedAt: 100, stale: false, hasCredits: true, balance: "1e3" });
  assert.equal(paidUsageLines("codex", raw, 120)[0]!.text, "Credits: 1e3 credits");
});

test("the compact footer value is formatted the same way; unlimited and none are unchanged", () => {
  const big = acct({ kind: "credits", fetchedAt: 100, stale: false, hasCredits: true, balance: "71023.5086225000" });
  assert.equal(paidFooterValue("codex", big.paidUsage), "71,023.51");
  assert.equal(paidFooterValue("codex", acct({ kind: "credits", fetchedAt: 1, stale: false, hasCredits: false }).paidUsage), "0");
  assert.equal(paidFooterValue("codex", acct({ kind: "credits", fetchedAt: 1, stale: false, unlimited: true }).paidUsage), "∞");
  assert.equal(paidFooterValue("codex", acct({ kind: "credits", fetchedAt: 1, stale: false, hasCredits: true, balance: "12.50" }).paidUsage), "12.5");
  const stale = footerCell({ provider: "codex", windowId: "paid", account: acct({ kind: "credits", fetchedAt: 1, stale: true, hasCredits: true, balance: "71023.5086225000" }), window: null }, { warning: 80, danger: 100, offline: false, narrow: false, now: 50 });
  assert.equal(stale.percent, "~71,023.51");
});

test("spoken footer labels say whole credits", () => {
  const cell = (balance: string, stale = false) =>
    footerCell({ provider: "codex", windowId: "paid", account: acct({ kind: "credits", fetchedAt: stale ? 1 : 40, stale, hasCredits: true, balance }), window: null }, { warning: 80, danger: 100, offline: false, narrow: false, now: 50 });
  assert.equal(footerSpeech("codex", cell("71023.5086225000")), "Codex credits, 71,023 credits");
  assert.equal(footerSpeech("codex", cell("71023.5086225000", true)), "Codex credits, about 71,023 credits, stale");
  assert.equal(footerSpeech("codex", cell("12.50")), "Codex credits, 12 credits");
  assert.equal(footerSpeech("codex", cell("1e3")), "Codex credits, 1e3 credits", "unparsed values are spoken raw");
  const none = footerCell({ provider: "codex", windowId: "paid", account: acct({ kind: "credits", fetchedAt: 40, stale: false, unlimited: true }), window: null }, { warning: 80, danger: 100, offline: false, narrow: false, now: 50 });
  assert.equal(footerSpeech("codex", none), "Codex credits, unlimited");
});
