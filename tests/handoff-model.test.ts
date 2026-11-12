import test from "node:test";
import assert from "node:assert/strict";
import { handoffActions, handoffActive, handoffLine, handoffTone } from "../client/handoff-model.js";
import type { Handoff } from "../shared/handoff.js";

const base: Handoff = {
  id: "h1", provider: "agy", target: "22222222-2222-4222-8222-222222222222", targetAlias: "home", trigger: "manual",
  restartDaemon: false, phase: "waiting", requestedAt: 1, deadline: 2, updatedAt: 1, waitingFor: 2, code: "turnRunning",
  message: "Waiting for 2 running turns to finish. Nothing is interrupted.", affected: [], reopened: [], failedReopen: [], daemonOutcome: null,
};

test("handoff lines name the phase, target and coordinator message", () => {
  assert.equal(handoffLine(base), "Waiting for idle (to home): Waiting for 2 running turns to finish. Nothing is interrupted.");
  assert.match(handoffLine({ ...base, trigger: "automaticSwitch", target: null, targetAlias: null }), /after automatic switch/);
  assert.equal(handoffTone({ ...base, phase: "uncertain" }), "warning");
  assert.equal(handoffTone({ ...base, phase: "done" }), "ok");
});

test("owner actions follow the phase", () => {
  assert.deepEqual(handoffActions(base), { cancel: true, reopen: false, dismiss: false });
  assert.ok(handoffActive(base));
  const stuck = { ...base, phase: "uncertain" as const, affected: ["a1", "a2"], reopened: ["a1"] };
  assert.deepEqual(handoffActions(stuck), { cancel: false, reopen: true, dismiss: true });
  assert.deepEqual(handoffActions({ ...stuck, reopened: ["a1", "a2"] }).reopen, false);
  assert.equal(handoffActive({ ...base, phase: "switching" }), true);
  assert.equal(handoffActive(null), false);
});
