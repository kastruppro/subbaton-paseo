import test from "node:test";
import assert from "node:assert/strict";
import {
  paceFraction,
  relativeReset,
  relativeAge,
  windowPresentation,
  splitWindows,
  accountTone,
} from "../client/display.js";
import type { Window, Account } from "../shared/contracts.js";
const window = (id = "five_hour", patch: Partial<Window> = {}): Window => ({
  id,
  label: "5h",
  usedPercent: 80,
  resetsAt: 18000,
  fetchedAt: 1,
  stale: false,
  inferred: false,
  ...patch,
});
test("pace is elapsed fraction, bounded and absent without reset/length or for inference", () => {
  assert.equal(paceFraction("claude", window(), 4500), 0.25);
  assert.equal(paceFraction("claude", window(), -1), 0);
  assert.equal(paceFraction("claude", window(), 20000), 1);
  assert.equal(
    paceFraction(
      "claude",
      window("weekly_scoped:Fable", { resetsAt: 604800 }),
      302400,
    ),
    0.5,
  );
  assert.equal(
    paceFraction(
      "codex",
      window("codex:primary_window", { windowSeconds: 18000 }),
      9000,
    ),
    0.5,
  );
  assert.equal(
    paceFraction("agy", window("gemini:weekly", { resetsAt: 604800 }), 302400),
    0.5,
  );
  assert.equal(paceFraction("agy", window("claude-gpt:5h"), 9000), 0.5);
  assert.equal(
    paceFraction("codex", window("codex:primary_window"), 9000),
    null,
  );
  assert.equal(
    paceFraction(
      "codex",
      window("codex:primary_window", { windowSeconds: 0 }),
      9000,
    ),
    null,
  );
  assert.equal(
    paceFraction("agy", window("gemini:" + "9".repeat(400) + "s"), 9000),
    null,
  );
  assert.equal(
    paceFraction("claude", window("five_hour", { resetsAt: null }), 9000),
    null,
  );
  assert.equal(
    paceFraction("claude", window("five_hour", { inferred: true }), 9000),
    null,
  );
});
test("relative reset labels use durations, tomorrow and weekday with separate absolute accessibility time", () => {
  const now = new Date(2026, 10, 12, 12, 0).getTime() / 1000;
  assert.equal(relativeReset(now + 6600, now), "resets in 1 h 50 min");
  assert.equal(
    relativeReset(new Date(2026, 10, 13, 11, 0).getTime() / 1000, now),
    "resets tomorrow 11:00",
  );
  assert.equal(
    relativeReset(new Date(2026, 10, 14, 7, 0).getTime() / 1000, now),
    "resets Sat 07:00",
  );
  assert.equal(relativeReset(null, now), "reset unknown");
  assert.equal(relativeReset(1e300, now), "reset unknown");
  assert.equal(relativeAge(now - 240, now), "4 min ago");
  assert.equal(relativeAge(null, now), "unknown");
});
test("stale bars retain threshold tone, dim and show clock, never tilde; only inference uses approximation", () => {
  const stale = windowPresentation(
    "claude",
    window("five_hour", { stale: true }),
    75,
    90,
    false,
    9000,
  );
  assert.equal(stale.percent, "80%");
  assert.equal(stale.clock, true);
  assert.equal(stale.opacity, 0.45);
  assert.equal(stale.tone, "warning");
  assert.ok(stale.accessibility.includes("stale"));
  assert.ok(stale.accessibility.includes("1970"));
  const inferred = windowPresentation(
    "claude",
    window("five_hour", { usedPercent: 0, inferred: true, resetsAt: null }),
    75,
    90,
    false,
    9000,
  );
  assert.equal(inferred.percent, "≈0%");
  assert.equal(inferred.tick, null);
  assert.equal(inferred.reset, "reset, presumed fresh");
});
test("main windows stay compact and model/second-group rows remain in details", () => {
  const rows = [
    window("weekly_scoped:Fable"),
    window("seven_day"),
    window("five_hour"),
  ];
  assert.deepEqual(
    splitWindows("claude", rows).main.map((v) => v.id),
    ["five_hour", "seven_day"],
  );
  assert.deepEqual(
    splitWindows("claude", rows).extra.map((v) => v.id),
    ["weekly_scoped:Fable"],
  );
  const agy = [
    window("claude-gpt:5h"),
    window("gemini:weekly"),
    window("gemini:5h"),
  ];
  assert.deepEqual(
    splitWindows("agy", agy).main.map((v) => v.id),
    ["gemini:5h", "gemini:weekly"],
  );
});
test("tab dot is the worst active tone, including health", () => {
  const account = {
    health: "ok",
    enabled: true,
    windows: [window(), window("seven_day", { usedPercent: 95 })],
  } as Account;
  assert.equal(accountTone(account, 75, 90), "danger");
  assert.equal(
    accountTone({ ...account, health: "needsLogin", windows: [] }, 75, 90),
    "danger",
  );
  assert.equal(accountTone(undefined, 75, 90), "unknown");
});

import { statusSchema } from "../shared/contracts.js";
import { status } from "./fixtures.js";
test("cache contract retains optional Codex duration and summary warnings without rejecting unknown duration", () => {
  const input = structuredClone(status) as any;
  input.providers[0].accounts[0].windows = [
    window("codex:primary_window", { windowSeconds: 0 }),
  ];
  input.providers[0].accounts[0].summaryStatus = "partial-groups";
  input.providers[0].accounts[0].warnings = ["Missing group retained stale"];
  const parsed = statusSchema.parse(input).providers[0]!.accounts[0]!;
  assert.equal(parsed.windows[0]!.windowSeconds, 0);
  assert.equal(parsed.summaryStatus, "partial-groups");
  assert.deepEqual(parsed.warnings, ["Missing group retained stale"]);
});
import { popoverBodyHeight } from "../client/display.js";
test("short native sheets keep the body scrollable below header and grabber", () => {
  for (let height = 360; height <= 1024; height += 32) {
    const body = popoverBodyHeight(true, height);
    assert.ok(body >= 80 && body <= 470);
    assert.ok(body + 110 <= height * 0.78 + 0.001);
  }
  assert.equal(popoverBodyHeight(false, 900), 470);
  assert.ok(Number.isFinite(popoverBodyHeight(true, NaN)));
});
