import test from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, footerHoverSurface } from "../client/contrast.js";
import { footerCell, footerSpeech } from "../client/footer-model.js";
import type { Account, Window } from "../shared/contracts.js";

// Paseo's real theme tokens, read (read-only) from the installed Paseo 0.15.4 web bundle
// (/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/index-*.js) on 2026-11-15:
// every shipped theme's surface0-2, surfaceSidebar and foregroundMuted; foreground and the status colours are
// shared by all dark themes (#e6e6e6, #c09664, #d8847b) and by the light theme (#1a1a1e, #7b5d39, #9d433b).
const darkShared = { foreground: "#e6e6e6", statusWarning: "#c09664", statusDanger: "#d8847b" };
const themes = {
  light: { surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", sidebar: "#f4f4f5", foregroundMuted: "#71717a", foreground: "#1a1a1e", statusWarning: "#7b5d39", statusDanger: "#9d433b" },
  dark: { surface0: "#181B1A", surface1: "#1E2120", surface2: "#272A29", sidebar: "#141716", foregroundMuted: "#A1A5A4", ...darkShared },
  zinc: { surface0: "#18181b", surface1: "#1f1f22", surface2: "#27272a", sidebar: "#131316", foregroundMuted: "#a1a1aa", ...darkShared },
  midnight: { surface0: "#161820", surface1: "#1c1e27", surface2: "#252731", sidebar: "#121420", foregroundMuted: "#9a9db0", ...darkShared },
  warm: { surface0: "#1f1f1e", surface1: "#262523", surface2: "#2f2d2b", sidebar: "#1a1918", foregroundMuted: "#ada9a5", ...darkShared },
  atom: { surface0: "#282c34", surface1: "#2f333d", surface2: "#383c48", sidebar: "#21252d", foregroundMuted: "#c8ccd8", ...darkShared },
  black: { surface0: "#000000", surface1: "#0a0a0a", surface2: "#111111", sidebar: "#000000", foregroundMuted: "#a1a1aa", ...darkShared },
} as const;
const surfaces = (t: (typeof themes)[keyof typeof themes]) => [t.surface0, t.surface1, t.surface2, t.sidebar];

test("contrast ratio maths", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
});
test("every shipped Paseo theme: foreground and the status colours meet WCAG AA on every surface the footer can sit on", () => {
  for (const [name, t] of Object.entries(themes)) {
    for (const surface of surfaces(t))
      assert.ok(contrastRatio(t.foreground, surface) >= 4.5, `${name} foreground on ${surface}`);
    // the footer sits on the sidebar and popover surfaces; the raised surface2 is covered by footerHoverSurface below
    for (const surface of [t.surface0, t.surface1, t.sidebar])
      for (const token of ["statusWarning", "statusDanger"] as const)
        assert.ok(contrastRatio(t[token], surface) >= 4.5, `${name} ${token} on ${surface}: ${contrastRatio(t[token], surface).toFixed(2)}`);
  }
});
test("every shipped Paseo theme: muted text meets AA on the popover surfaces; where it does not on a raised surface the text uses foreground", () => {
  for (const [name, t] of Object.entries(themes)) {
    for (const surface of [t.surface0, t.surface1])
      assert.ok(contrastRatio(t.foregroundMuted, surface) >= 4.5, `${name} muted on ${surface}: ${contrastRatio(t.foregroundMuted, surface).toFixed(2)}`);
  }
  // Known real gap: light muted on the hovered/raised surface2 is 4.40:1, so text drawn on surface2
  // (the footer message while hovered, the Switch-when-idle explanation) uses foreground.
  assert.ok(contrastRatio(themes.light.foregroundMuted, themes.light.surface2) < 4.5);
  assert.ok(contrastRatio(themes.light.foreground, themes.light.surface2) >= 4.5);
});
test("FC-3: the hovered footer surface keeps foreground and status text AA in every shipped theme", () => {
  for (const [name, t] of Object.entries(themes)) {
    const hover = footerHoverSurface({ surface1: t.surface1, surface2: t.surface2, foreground: t.foreground, statusWarning: t.statusWarning, statusDanger: t.statusDanger });
    for (const token of ["foreground", "statusWarning", "statusDanger"] as const)
      assert.ok(contrastRatio(t[token], hover) >= 4.5, `${name} ${token} on hover ${hover}`);
  }
  const pick = (n: keyof typeof themes) => { const t = themes[n]; return footerHoverSurface({ surface1: t.surface1, surface2: t.surface2, foreground: t.foreground, statusWarning: t.statusWarning, statusDanger: t.statusDanger }); };
  assert.equal(pick("light"), themes.light.surface2, "the usual hover surface is kept where it is readable");
  assert.equal(pick("atom"), themes.atom.surface1, "atom's amber and red fall below AA on surface2, so it hovers on surface1");
  // a theme where neither works falls back to surface1 (never a lower-contrast surface)
  assert.equal(footerHoverSurface({ surface1: "#777777", surface2: "#787878", foreground: "#777777", statusWarning: "#777777", statusDanger: "#777777" }), "#777777");
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

test("FC-2: every footer cell has a spoken label naming stale, unknown, near limit and unavailable", () => {
  const speak = (a: Account | null, w: Window | null, offline = false) =>
    footerSpeech("claude", cell(a, w, offline));
  assert.equal(speak(acct(), win({ usedPercent: 7 })), "Claude 5 hours, 7 percent used");
  assert.equal(speak(acct(), win({ usedPercent: 7, stale: true })), "Claude 5 hours, about 7 percent used, stale");
  assert.equal(speak(acct(), win({ usedPercent: null })), "Claude 5 hours, unknown");
  assert.equal(speak(null, null), "Claude 5 hours, unknown");
  assert.equal(speak(acct(), win({ usedPercent: 85 })), "Claude 5 hours, 85 percent used, near limit");
  assert.equal(speak(acct(), win({ usedPercent: 100 })), "Claude 5 hours, 100 percent used, exhausted");
  assert.equal(speak(acct({ health: "needsLogin" }), win()), "Claude 5 hours, unavailable");
  assert.equal(speak(acct(), win({ usedPercent: 0, inferred: true })), "Claude 5 hours, about 0 percent used, estimated");
  const agy = footerCell({ provider: "agy", windowId: "claude-gpt:5h", account: acct(), window: win({ id: "claude-gpt:5h", usedPercent: 80 }) }, { warning: 80, danger: 100, offline: false, narrow: true, now: 50 });
  assert.equal(footerSpeech("agy", agy), "agy Claude and GPT 5 hours, 80 percent used, near limit", "short visual labels are spoken in full");
  const codex = footerCell({ provider: "codex", windowId: "paid", account: acct({ paidUsage: { kind: "credits", fetchedAt: 40, stale: false, hasCredits: true, balance: "12.50" } }), window: null }, { warning: 80, danger: 100, offline: false, narrow: false, now: 50 });
  assert.equal(footerSpeech("codex", codex), "Codex credits, 12.50");
  const stale = footerCell({ provider: "codex", windowId: "paid", account: acct({ paidUsage: { kind: "credits", fetchedAt: 1, stale: true, hasCredits: true, balance: "12.50" } }), window: null }, { warning: 80, danger: 100, offline: false, narrow: false, now: 50 });
  assert.equal(footerSpeech("codex", stale), "Codex credits, about 12.50, stale");
  const none = footerCell({ provider: "claude", windowId: "paid", account: acct(), window: null }, { warning: 80, danger: 100, offline: false, narrow: false, now: 50 });
  assert.equal(footerSpeech("claude", none), "Claude extra usage, unknown");
});

test("a custom danger threshold below 100 is spoken like it is shown", () => {
  const custom = (value: number) =>
    footerSpeech("claude", footerCell({ provider: "claude", windowId: "five_hour", account: acct(), window: win({ usedPercent: value }) }, { warning: 75, danger: 90, offline: false, narrow: false, now: 50 }));
  assert.equal(custom(50), "Claude 5 hours, 50 percent used");
  assert.equal(custom(80), "Claude 5 hours, 80 percent used, near limit");
  assert.equal(custom(96), "Claude 5 hours, 96 percent used, over the danger threshold");
  assert.equal(custom(100), "Claude 5 hours, 100 percent used, exhausted");
});
