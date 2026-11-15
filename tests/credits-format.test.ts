import test from "node:test";
import assert from "node:assert/strict";
import { formatCredits, formatCreditsWhole, spokenCredits } from "../client/credits-format.js";
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
    ["0.0049999", "<0.01"],
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
  assert.equal(footerSpeech("codex", cell("1")), "Codex credits, 1 credit");
  assert.equal(footerSpeech("codex", cell("1e3")), "Codex credits, 1e3 credits", "unparsed values are spoken raw");
  const none = footerCell({ provider: "codex", windowId: "paid", account: acct({ kind: "credits", fetchedAt: 40, stale: false, unlimited: true }), window: null }, { warning: 80, danger: 100, offline: false, narrow: false, now: 50 });
  assert.equal(footerSpeech("codex", none), "Codex credits, unlimited");
});

test("CF-1: a positive balance that rounds to zero is never shown as 0", () => {
  for (const raw of ["0.004", "0.0049999", "0.000001", "+0.001", "0.0000000000000001"]) assert.equal(formatCredits(raw), "<0.01", raw);
  assert.equal(formatCredits("0.005"), "0.01");
  assert.equal(formatCredits("0"), "0", "an exact zero stays 0");
  assert.equal(formatCredits("0.000"), "0");
  assert.equal(formatCredits("-0.004"), "0", "tiny negative values may stay 0");
  assert.equal(spokenCredits("0.004"), "less than 1 credit");
  assert.equal(spokenCredits("0.4"), "less than 1 credit");
  assert.equal(spokenCredits("0"), "0 credits");
  assert.equal(spokenCredits("1"), "1 credit");
  assert.equal(spokenCredits("12.5"), "12 credits");
  assert.equal(spokenCredits("71023.5086225000"), "71,023 credits");
  assert.equal(spokenCredits("1e3"), "1e3 credits");
  const tiny = acct({ kind: "credits", fetchedAt: 100, stale: false, hasCredits: true, balance: "0.004" });
  assert.equal(paidUsageLines("codex", tiny, 120)[0]!.text, "Credits: <0.01 credits");
  assert.equal(paidFooterValue("codex", tiny.paidUsage), "<0.01");
  const cell = footerCell({ provider: "codex", windowId: "paid", account: tiny, window: null }, { warning: 80, danger: 100, offline: false, narrow: false, now: 50 });
  assert.equal(cell.percent, "<0.01");
  assert.equal(footerSpeech("codex", cell), "Codex credits, less than 1 credit");
  const none = acct({ kind: "credits", fetchedAt: 100, stale: false, hasCredits: false, balance: "0.00" });
  assert.equal(paidUsageLines("codex", none, 120)[0]!.text, "Credits: none (0 credits)");
});

test("CF-2: every credits detail line has a spoken label with whole credits", () => {
  const line = (paid: Record<string, unknown>, resets?: number) =>
    paidUsageLines("codex", { ...acct({ kind: "credits", fetchedAt: 100, stale: false, hasCredits: true, ...paid }), ...(resets === undefined ? {} : { resetCreditsAvailable: resets }) }, 120);
  assert.equal(line({ balance: "71023.5086225000" })[0]!.spoken, "Credits, 71,023 credits");
  assert.equal(line({ balance: "71023.5086225000", stale: true })[0]!.spoken, "Credits, about 71,023 credits, stale");
  assert.equal(line({ balance: "12.50", approxLocalMessages: 24, approxCloudMessages: 4 })[0]!.spoken, "Credits, 12 credits, estimate: about 24 local or 4 cloud messages");
  assert.equal(line({ balance: "0.004" })[0]!.spoken, "Credits, less than 1 credit");
  assert.equal(line({ balance: "1e3" })[0]!.spoken, "Credits, 1e3 credits");
  assert.equal(line({ unlimited: true })[0]!.spoken, "Credits, unlimited");
  assert.equal(line({ hasCredits: false, balance: "0.00" })[0]!.spoken, "Credits, none");
  assert.equal(line({ hasCredits: undefined, balance: undefined })[0]!.spoken, "Credits, unknown");
  assert.equal(line({ balance: "5" }, 2)[1]!.spoken, "Banked resets: 2");
  // the written text keeps the ~ and grouping, the spoken text never contains them
  for (const l of line({ balance: "71023.5086225000", stale: true })) assert.ok(!l.spoken.includes("~"));
  const claude = paidUsageLines("claude", acct({ kind: "extraUsage", fetchedAt: 100, stale: false, enabled: true, usedCredits: 120 }), 120);
  assert.deepEqual(claude.map((l) => l.spoken), claude.map((l) => l.text));
});
