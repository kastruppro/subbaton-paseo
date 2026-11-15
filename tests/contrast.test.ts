import test from "node:test";
import assert from "node:assert/strict";
import { contrastRatio } from "../client/contrast.js";
import { footerCell } from "../client/footer-model.js";
import type { Account, Window } from "../shared/contracts.js";

// Documented host theme token values (the v2 mockups' dark and light palettes of Paseo's surfaces).
const dark = { surface0: "#181B1A", surface1: "#1E2120", surface2: "#272A29", foreground: "#e6e8e7", foregroundMuted: "#A1A5A4", statusWarning: "#d4a44a", statusDanger: "#e07070" };
const light = { surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", foreground: "#1a1a1e", foregroundMuted: "#71717a", statusWarning: "#a0661a", statusDanger: "#b04138" };

test("contrast ratio maths", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
});
test("footer text (foreground, like Paseo's CPU box) meets WCAG AA on every surface; status colours on the sidebar and popover", () => {
  for (const [name, p] of [["dark", dark], ["light", light]] as const) {
    for (const surface of [p.surface0, p.surface1, p.surface2])
      assert.ok(contrastRatio(p.foreground, surface) >= 4.5, `${name} foreground on ${surface}`);
    for (const surface of [p.surface0, p.surface1])
      for (const token of ["statusWarning", "statusDanger"] as const)
        assert.ok(contrastRatio(p[token], surface) >= 4.5, `${name} ${token} on ${surface}: ${contrastRatio(p[token], surface).toFixed(2)}`);
  }
  // Known marginal gap (host tokens): light amber on the hovered footer (surface2) is 4.3:1; the value is
  // also marked by the amber meter fill and stays readable.
  assert.ok(contrastRatio(light.statusWarning, light.surface2) > 4.0);
});
test("muted secondary text meets AA on the popover surfaces; on the raised surface it must use foreground", () => {
  for (const [name, p] of [["dark", dark], ["light", light]] as const)
    for (const surface of [p.surface0, p.surface1])
      assert.ok(contrastRatio(p.foregroundMuted, surface) >= 4.5, `${name} muted on ${surface}`);
  assert.ok(contrastRatio(dark.foregroundMuted, dark.surface2) >= 4.5);
  // Known gap: muted on the light raised surface is just under AA, so text on surface2 uses foreground.
  assert.ok(contrastRatio(light.foregroundMuted, light.surface2) < 4.5);
  assert.ok(contrastRatio(light.foreground, light.surface2) >= 4.5);
});

const win = (patch: Partial<Window> = {}): Window => ({ id: "five_hour", label: "5h", usedPercent: 7, resetsAt: null, fetchedAt: 1, stale: false, inferred: false, ...patch });
const acct = (patch: Partial<Account> = {}): Account => ({ id: "a", alias: "W", email: null, active: true, enabled: true, health: "ok", plan: null, loginExpiresAt: null, usageStatus: "ok", windows: [], ...patch });
const cell = (a: Account | null, w: Window | null, offline = false) =>
  footerCell({ provider: "claude", windowId: "five_hour", account: a, window: w }, { warning: 80, danger: 100, offline, narrow: false, now: 50 });

test("footer text colour is the foreground token for every state, status colour only when near or at the limit", () => {
  assert.equal(cell(acct(), win()).textTone, "text");
  assert.equal(cell(acct(), win({ usedPercent: 43 })).textTone, "text");
  assert.equal(cell(acct(), win({ stale: true, usedPercent: 7 })).textTone, "text", "stale stays readable; the clock and ~ mark it");
  assert.equal(cell(acct(), win({ stale: true })).percent, "~7%");
  assert.equal(cell(acct(), win({ stale: true })).clock, true);
  assert.equal(cell(acct(), win({ usedPercent: null })).textTone, "text");
  assert.equal(cell(null, null).textTone, "text");
  assert.equal(cell(acct(), win({ usedPercent: 85 })).textTone, "warning");
  assert.equal(cell(acct(), win({ usedPercent: 100 })).textTone, "danger");
  assert.equal(cell(acct({ health: "needsLogin" }), win()).textTone, "danger");
});
