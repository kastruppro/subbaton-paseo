import test from "node:test";
import assert from "node:assert/strict";
import { chooseItems, severity, percentText } from "../client/display.js";
test("missing and stale quota is never shown as a fresh zero", () => {
  assert.equal(percentText(null, false), "—");
  assert.equal(percentText(25, true), "~25%");
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
