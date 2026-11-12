import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseItems,
  severity,
  percentText,
  windowTitle,
} from "../client/display.js";
test("missing and stale quota is never shown as a fresh zero", () => {
  assert.equal(percentText(null, false), "—");
  assert.equal(percentText(25, true), "25%");
  assert.equal(severity(null, true, 75, 90), "unknown");
  assert.equal(severity(95, false, 75, 90), "danger");
});
test("pinned items follow active accounts and include unavailable selections", () => {
  const rows = chooseItems({ cacheOnly: true, generatedAt: 1, providers: [] }, [
    { provider: "claude", windowId: "five_hour" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.window, null);
});

test("unknown readings keep friendly labels instead of schema keys", () => {
  assert.equal(windowTitle("five_hour"), "5-hour limit");
  assert.equal(windowTitle("weekly_scoped:Fable"), "Fable");
  assert.equal(windowTitle("codex:primary_window"), "Primary window");
});

import { stripLayout } from "../client/display.js";
import { displaySettings } from "../shared/contracts.js";
import { defineSettings } from "@getpaseo/plugin";
test("L4 footer drops detail and caps items to width without wrapping", () => {
  const wide = stripLayout(680, 4);
  assert.equal(wide.labels, true);
  assert.equal(wide.count, 4);
  const medium = stripLayout(500, 4);
  assert.equal(medium.labels, false);
  assert.equal(medium.meters, true);
  const narrow = stripLayout(400, 4);
  assert.equal(narrow.meters, false);
  assert.equal(narrow.count, 4);
  const mobile = stripLayout(220, 4);
  assert.ok(mobile.count < 4);
  assert.ok(mobile.usedWidth <= 220);
  assert.equal(mobile.hidden, 4 - mobile.count);
  for (let width = 64; width <= 600; width += 8)
    for (let count = 1; count <= 24; count++)
      assert.ok(stripLayout(width, count).usedWidth <= width);
});
test("L4 targeted SDK has no device settings API; host fallback is explicit", () => {
  assert.equal(displaySettings.scope, "host");
  assert.throws(
    () => defineSettings({ ...displaySettings, scope: "device" } as never),
    /host-scoped/,
  );
});
test("inferred reset values remain visibly presumed when footer labels shrink", () => {
  assert.equal(percentText(0, false, true), "≈0%");
});
