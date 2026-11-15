import test from "node:test";
import assert from "node:assert/strict";
import {
  windowPresentation,
  themePalette,
  actionNotice,
  shortWarning,
  keyboardFocus,
} from "../client/display.js";
import type { Window } from "../shared/contracts.js";
const win: Window = {
  id: "five_hour",
  label: "5h",
  usedPercent: 80,
  resetsAt: 1000,
  fetchedAt: 1,
  stale: false,
  inferred: false,
};
test("passed reset never displays old quota or an elapsed tick; only issuer/cache inference shows approximate zero", () => {
  const view = windowPresentation("claude", win, 75, 90, false, 1001);
  assert.equal(view.percent, "—");
  assert.equal(view.tick, null);
  assert.equal(view.reset, "reset passed, refresh to update");
  assert.equal(view.opacity, 0.45);
  assert.equal(view.fillPercent, 0);
  const inferred = windowPresentation(
    "claude",
    { ...win, inferred: true, usedPercent: 0, resetsAt: null },
    75,
    90,
    false,
    1001,
  );
  assert.equal(inferred.percent, "≈0%");
  assert.equal(inferred.tick, null);
});
test("palette follows all supplied light or dark host tokens", () => {
  for (const light of [true, false]) {
    const colors = Object.fromEntries(
      [
        "surface0",
        "surface1",
        "surface2",
        "border",
        "foreground",
        "foregroundMuted",
        "accent",
        "accentForeground",
        "statusSuccess",
        "statusWarning",
        "statusDanger",
      ].map((k) => [k, (light ? "light-" : "dark-") + k]),
    );
    const p = themePalette({ colors } as never);
    assert.equal(p.pop, colors.surface1);
    assert.equal(p.hover, colors.surface2);
    assert.equal(p.text, colors.foreground);
  }
});
test("routine successes disappear; failures stay short and preserve recovery instruction", () => {
  assert.equal(
    actionNotice({ outcome: "success", code: "ok", message: "Usage done" }),
    null,
  );
  assert.equal(
    actionNotice({
      outcome: "unchanged",
      code: "alreadyActive",
      message: "Already active",
    }),
    null,
  );
  assert.ok(
    actionNotice({
      outcome: "uncertain",
      code: "uncertain",
      message: "Original cause. Run recovery.",
    })?.includes("recovery"),
  );
  // The amber "Gemini quota not reported by Google" warning is gone (neutral "Gemini: not available" line instead).
  assert.equal(shortWarning("agy", "partial-groups", ["Long explanation"]), null);
});
test("focus ring requires focus-visible, never plain click focus", () => {
  assert.equal(
    keyboardFocus({
      matches: (selector: string) => selector === ":focus-visible",
    }),
    true,
  );
  assert.equal(keyboardFocus({ matches: () => false }), false);
  assert.equal(keyboardFocus(123), false);
});

import { providerNotices } from "../client/display.js";
test("refresh failures stay on their provider and successes clear old notices", () => {
  const error = {
    outcome: "error" as const,
    code: "network",
    message: "Usage unavailable",
  };
  const success = {
    outcome: "success" as const,
    code: "ok",
    message: "Routine success",
  };
  const notices = providerNotices(
    { claude: "old failure" },
    [
      { provider: "agy", result: error },
      { provider: "claude", result: success },
    ],
    "codex",
  );
  assert.equal(notices.agy, "Usage unavailable");
  assert.equal(notices.claude, undefined);
  assert.equal(notices.codex, undefined);
  const uncertain = {
    outcome: "uncertain" as const,
    code: "uncertain",
    message: "agy is running. Inspect recovery.",
    cause: "processesRunning",
  };
  assert.ok(actionNotice(uncertain)?.includes("agy is running"));
  assert.ok(actionNotice(uncertain)?.includes("recovery"));
});
test("settings screen uses only host theme tokens and labels every custom control", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../client/control.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  const pressables = source.match(/<Pressable\b[\s\S]*?>/g) ?? [];
  assert.ok(pressables.length > 0);
  for (const p of pressables) {
    assert.match(p, /accessibilityRole=/);
    assert.match(p, /accessibilityLabel=/);
  }
});
test("handoff section and popover additions use only host theme tokens", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["../client/handoff-section.tsx", "../client/views.tsx"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b|rgba?\(|hsla?\(/, file);
  }
});
