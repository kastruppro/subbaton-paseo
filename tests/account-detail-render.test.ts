import test from "node:test";
import assert from "node:assert/strict";
import { loadDetailRenderer } from "./render/load.js";
import type { Account } from "../shared/contracts.js";

const NOW = Math.floor(Date.now() / 1000);
const win = (id: string, label: string, patch: Record<string, unknown> = {}) => ({ id, label, usedPercent: 40, resetsAt: NOW + 3600, stale: false, inferred: false, fetchedAt: NOW - 600, ...patch });
const account = (patch: Partial<Account> = {}): Account => ({
  id: "i1", alias: "Pro", email: "tobias@example.test", active: false, enabled: true, health: "ok", plan: "Pro", loginExpiresAt: null, usageStatus: "ok",
  windows: [win("codex:primary_window", "5-hour"), win("codex:secondary_window", "Weekly", { usedPercent: 100, stale: true, fetchedAt: NOW - 90000 }), win("codex:x:primary_window", "Spark 5h", { inferred: true, usedPercent: 0 })],
  resetCreditsAvailable: 2,
  ...patch,
} as Account);

test("the shared detail block renders identity, every window with its marking, read time, login and banked resets", async () => {
  const render = await loadDetailRenderer();
  const html = render("codex", account());
  for (const needle of ["tobias@example.test", "Pro", "Weekly", "5-hour", "Spark 5h", "Banked resets: 2", "login has no fixed end date", "Read "])
    assert.ok(html.includes(needle), `${needle}\n${html}`);
  assert.match(html, /stale/i, "a stale reading is marked");
  assert.match(html, /estimated|presumed|inferred/i, "an estimated reading is marked");
  assert.match(html, /pace/i, "the pace legend");
});
test("the detail block shows the health state and an unknown-usage note when there are no windows", async () => {
  const render = await loadDetailRenderer();
  const html = render("agy", account({ windows: [], health: "quarantined", usageStatus: "needs-renewal", resetCreditsAvailable: undefined }));
  assert.ok(html.includes("Quarantined"), html);
  assert.ok(html.includes("Usage unknown. No quota is assumed."), html);
});
